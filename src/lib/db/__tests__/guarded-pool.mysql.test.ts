// 主连接池在数据库卡死时的回收(真实 MySQL + 可冻结代理):
// 握手与执行中的命令有期限、到期真正断开套接字、连接池自己恢复;事务里的非数据库空档不计时。

import { randomUUID } from "node:crypto";
import { createDb, databaseProbe } from "@/lib/db/client";
import { DbCommandTimeout } from "@/lib/db/guarded-pool";
import { runs as runsTable } from "@/lib/db/schema";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sleep, startFreezeProxy, trackClientSockets } from "./freeze-proxy";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 主连接池卡死回收的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("主连接池卡死回收(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  // 直连(不经代理)的连接:建测试数据、从另一条连接抢行锁
  const direct = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(direct.db);
  const ids: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const c of cleanups) await c();
    if (ids.length) await direct.db.delete(runsTable).where(inArray(runsTable.id, ids));
    await direct.pool.end();
  });

  async function newRun(): Promise<string> {
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    ids.push(id);
    await repo.create({ id, sessionId: `s-guard-${id.slice(0, 6)}`, prompt: "p" });
    return id;
  }

  /** 经代理的主连接池:只有 1 条连接 —— 卡住的连接若没被真正释放,之后一条都用不了 */
  async function poolViaProxy(o: { handshakeMs: number; commandMs: number }) {
    const proxy = await startFreezeProxy(new URL(TEST_DB_URL as string));
    const { db, pool } = createDb(proxy.url, { connectionLimit: 1, ...o });
    cleanups.push(async () => {
      proxy.heal();
      await Promise.race([pool.end(), sleep(1_000)]);
      await proxy.close();
    });
    return { proxy, db, pool, track: trackClientSockets(proxy.port) };
  }

  describe("主连接池卡死回收(真实 MySQL)", { timeout: 30_000 }, () => {
    it("问候已到、认证卡住:获取连接有界失败,握手中的套接字被关闭;单连接池名额用尽后恢复照常可用", async () => {
      const { proxy, db, track } = await poolViaProxy({ handshakeMs: 300, commandMs: 300 });
      proxy.state.stallAuth = true; // 还没有任何连接:第一次查询就要新建,卡在认证
      for (let i = 0; i < 3; i++) {
        const before = proxy.state.serverBytes;
        const t0 = Date.now();
        await expect(db.execute(sql`SELECT 1`)).rejects.toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(proxy.state.serverBytes).toBeGreaterThan(before); // 确实停在问候之后
        await sleep(50);
        expect(track.alive()).toBe(0); // 没有半开的握手连接占着名额
      }
      expect(proxy.state.peak).toBe(1);

      proxy.heal();
      await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined();
    });

    it("握手完成后解除握手计时:超过握手期限的健康连接不会被断开、不重连", async () => {
      const { db, track } = await poolViaProxy({ handshakeMs: 300, commandMs: 5_000 });
      await db.execute(sql`SELECT 1`);
      await sleep(800);
      await db.execute(sql`SELECT 2`);
      expect(track.sockets).toHaveLength(1);
      expect(track.alive()).toBe(1);
    });

    it("执行中的命令卡死且对端不回应 FIN:到期抛 DbCommandTimeout、套接字真正关闭;连续卡住不累积,恢复后照常可用", async () => {
      const { proxy, db, track } = await poolViaProxy({ handshakeMs: 2_000, commandMs: 300 });
      await db.execute(sql`SELECT 1`); // 建好连接
      proxy.state.frozen = true;
      proxy.state.ignoreFin = true;
      const first = await db.execute(sql`SELECT 1`).catch((e) => e);
      expect(first).toBeInstanceOf(DbCommandTimeout);
      for (let i = 0; i < 2; i++) {
        const t0 = Date.now();
        // 之后的查询要新建连接:冻结中握手也卡,由握手期限(2 秒)收住
        await expect(db.execute(sql`SELECT 1`)).rejects.toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(3_500);
      }
      await sleep(50);
      // 从客户端一侧看:每次一条套接字,全部已真正关闭(代理开着 ignoreFin,它那头的计数会留着半开的连接,不能作数)
      expect(track.sockets).toHaveLength(3);
      expect(track.alive()).toBe(0);

      proxy.heal();
      await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined();
    });

    it("事务里的非数据库空档(远超命令期限)不计时:连接不被断开、行锁一直持有到提交", async () => {
      const id = await newRun();
      const { db, track } = await poolViaProxy({ handshakeMs: 2_000, commandMs: 200 });
      let otherGotLock = false;
      let other: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM runs WHERE id = ${id} FOR UPDATE`);
        // 另一条连接来抢同一行:应一直等到本事务提交
        other = direct.db.transaction(async (t2) => {
          await t2.execute(sql`SELECT id FROM runs WHERE id = ${id} FOR UPDATE`);
          otherGotLock = true;
        });
        await sleep(1_200); // 模拟事务里的文件操作 —— 是命令期限的 6 倍
        expect(otherGotLock).toBe(false);
        await tx.execute(sql`UPDATE runs SET prompt = 'after-gap' WHERE id = ${id}`);
      });
      await other;
      expect(otherGotLock).toBe(true);
      expect(track.sockets).toHaveLength(1); // 全程同一条连接,没有被断开重连
      const rows = (await direct.db.execute(
        sql`SELECT prompt FROM runs WHERE id = ${id}`,
      )) as unknown as [{ prompt: string }[]];
      expect(rows[0][0]?.prompt).toBe("after-gap");
    });

    it("事务里的命令卡死:到期断开,事务随连接结束、行锁释放,别的连接随即能锁到", async () => {
      const id = await newRun();
      const { proxy, db } = await poolViaProxy({ handshakeMs: 2_000, commandMs: 300 });
      const tx = db.transaction(async (t) => {
        await t.execute(sql`SELECT id FROM runs WHERE id = ${id} FOR UPDATE`);
        proxy.state.frozen = true;
        await t.execute(sql`UPDATE runs SET prompt = 'never' WHERE id = ${id}`);
      });
      await expect(tx).rejects.toBeInstanceOf(Error);
      proxy.heal();
      // 服务器侧:连接断开后事务回滚、行锁释放(给服务器一点时间察觉连接断开)
      const t0 = Date.now();
      await direct.db.transaction(async (t2) => {
        await t2.execute(sql`SELECT id FROM runs WHERE id = ${id} FOR UPDATE`);
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      const rows = (await direct.db.execute(
        sql`SELECT prompt FROM runs WHERE id = ${id}`,
      )) as unknown as [{ prompt: string }[]];
      expect(rows[0][0]?.prompt).toBe("p");
    });

    it("健康检查的数据库探测单一在途:连接都停在事务空档(不能强杀)时,频繁探测按时报不可用,连接池里只排一个;放行后恢复", async () => {
      const id = await newRun();
      // 不经代理的单连接池:数据库正常,只是唯一的连接被事务占着
      const { db, pool } = createDb(TEST_DB_URL as string, {
        connectionLimit: 1,
        commandMs: 2_000,
      });
      cleanups.push(() => pool.end());
      let enqueued = 0;
      pool.raw.on("enqueue", () => {
        enqueued++;
      });
      const probeDatabase = databaseProbe(pool);
      /** 与 health/route.ts 的 probe 同样:外层超时只是不再等 */
      const healthCheck = () =>
        Promise.race([probeDatabase().then(() => "ok"), sleep(300).then(() => "unavailable")]);

      let releaseTx!: () => void;
      const txGap = new Promise<void>((r) => {
        releaseTx = r;
      });
      let inGap!: () => void;
      const reachedGap = new Promise<void>((r) => {
        inGap = r;
      });
      const tx = db.transaction(async (t) => {
        await t.execute(sql`SELECT id FROM runs WHERE id = ${id} FOR UPDATE`);
        inGap();
        await txGap; // 事务里的文件操作空档:没有命令在执行,不会被强杀
        await t.execute(sql`UPDATE runs SET prompt = 'tx-done' WHERE id = ${id}`);
      });
      await reachedGap;

      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        expect(await healthCheck()).toBe("unavailable");
        expect(Date.now() - t0).toBeLessThan(800);
      }
      // 5 次探测,连接池里只排了一个获取连接的请求
      expect(enqueued).toBe(1);

      releaseTx();
      await tx; // 事务照常提交,行锁全程持有
      expect(await healthCheck()).toBe("ok");
      expect(enqueued).toBe(1);
      const rows = (await direct.db.execute(
        sql`SELECT prompt FROM runs WHERE id = ${id}`,
      )) as unknown as [{ prompt: string }[]];
      expect(rows[0][0]?.prompt).toBe("tx-done");
    });

    it("更短命令期限的视图(健康检查用)共享同一个连接池,卡住时按自己的期限收尾", async () => {
      const { proxy, db, pool } = await poolViaProxy({ handshakeMs: 2_000, commandMs: 10_000 });
      const { dbOver } = await import("@/lib/db/client");
      const probe = dbOver(pool.withCommandTimeout(200));
      await db.execute(sql`SELECT 1`);
      proxy.state.frozen = true;
      const t0 = Date.now();
      await expect(probe.execute(sql`SELECT 1`)).rejects.toBeInstanceOf(DbCommandTimeout);
      expect(Date.now() - t0).toBeLessThan(1_500);
    });
  });
}
