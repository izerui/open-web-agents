// 有时限的结果读取在真实 MySQL 上:连接卡死(网络不通而 TCP 没断开)时,
// 超时要真正结束底层查询(断开那条连接),而不是只是不再等 —— 否则卡住的连接被放回池里,
// 之后的查询一起卡死,终态兜底永远收不了尾。
//
// 用一个可"冻结"的 TCP 代理模拟卡死:冻结时两头都不转发,连接保持打开。

import { randomUUID } from "node:crypto";
import { sleep, startFreezeProxy, trackClientSockets } from "@/lib/db/__tests__/freeze-proxy";
import { createDb } from "@/lib/db/client";
import { runs as runsTable } from "@/lib/db/schema";
import {
  BoundedResultReader,
  ResultReadTimeout,
} from "@/lib/modules/run/adapters/bounded-result-reader";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 有时限结果读取的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("有时限的结果读取(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(db);
  const ids: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const c of cleanups) await c();
    if (ids.length) await db.delete(runsTable).where(inArray(runsTable.id, ids));
    await pool.end();
  });

  async function newRun(): Promise<string> {
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    ids.push(id);
    await repo.create({ id, sessionId: `s-bounded-${id.slice(0, 6)}`, prompt: "p" });
    return id;
  }

  /** 经代理连库的读取源:只允许 1 条连接 —— 卡住的连接若没被真正断开,之后一条都读不了 */
  async function readerViaProxy(timeoutMs: number) {
    const proxy = await startFreezeProxy(new URL(TEST_DB_URL as string));
    const reader = new BoundedResultReader({
      databaseUrl: proxy.url,
      maxConnections: 1,
      timeoutMs,
      closeWaitMs: 1_000,
    });
    cleanups.push(async () => {
      proxy.state.frozen = false;
      proxy.state.stallAuth = false;
      await reader.end();
      await proxy.close();
    });
    return { proxy, reader };
  }

  describe("有时限的结果读取(真实 MySQL,连接卡死)", { timeout: 30_000 }, () => {
    it("卡死时超时即断开那条连接、底层查询结束;连续卡住不积压连接;恢复后单连接的池照常可读", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(300);
      expect((await reader.getResult(id))?.status).toBe("pending");
      expect(proxy.state.open).toBe(1);

      proxy.state.frozen = true;
      for (let i = 0; i < 4; i++) {
        const t0 = Date.now();
        await expect(reader.getResult(id)).rejects.toBeInstanceOf(Error);
        // 有上限:一次读取的总期限 300ms(排队 + 握手 + 查询),加上等套接字关闭
        expect(Date.now() - t0).toBeLessThan(2_000);
        // 返回时那条连接已经断开:没有卡住的连接留在池里或代理上
        await sleep(50);
        expect(proxy.state.open).toBe(0);
      }
      // 全程同一时刻最多一条连接
      expect(proxy.state.peak).toBe(1);

      proxy.state.frozen = false;
      await db
        .update(runsTable)
        .set({ status: "success", finalText: "完成" })
        .where(eq(runsTable.id, id));
      expect(await reader.getResult(id)).toMatchObject({ status: "success", finalText: "完成" });
    });

    it("第一次超时是在查询阶段(连接已建好):抛 ResultReadTimeout,且那条连接被断开", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(300);
      await reader.getResult(id); // 建好连接
      proxy.state.frozen = true;
      await expect(reader.getResult(id)).rejects.toBeInstanceOf(ResultReadTimeout);
      await sleep(50);
      expect(proxy.state.open).toBe(0);
    });

    it("问候已到、认证卡住(驱动的建连计时器已被第一段数据清掉):读取有界失败,握手中的连接被断开;恢复后单连接照常收尾", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(300);
      proxy.state.stallAuth = true; // 还没有任何连接:第一次读取就要新建,卡在认证
      for (let i = 0; i < 3; i++) {
        const before = proxy.state.serverBytes;
        const t0 = Date.now();
        await expect(reader.getResult(id)).rejects.toBeInstanceOf(ResultReadTimeout);
        expect(Date.now() - t0).toBeLessThan(2_000);
        // 确实停在问候之后:服务器的问候送到了客户端
        expect(proxy.state.serverBytes).toBeGreaterThan(before);
        // 握手中的那条连接被断开,没有半开的连接占着名额
        await sleep(50);
        expect(proxy.state.open).toBe(0);
      }
      expect(proxy.state.peak).toBe(1);

      proxy.state.stallAuth = false;
      await db
        .update(runsTable)
        .set({ status: "success", finalText: "完成" })
        .where(eq(runsTable.id, id));
      expect(await reader.getResult(id)).toMatchObject({ status: "success", finalText: "完成" });
    });

    it("名额被占满时并发的读取都在期限内结束(占用者到期断开即唤醒排队者),之后照常可读", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(300);
      await reader.getResult(id); // 建好唯一的连接
      proxy.state.frozen = true;
      const t0 = Date.now();
      // 两次并发:一次占着唯一连接卡在查询,另一次排队 —— 都在期限内失败
      const results = await Promise.allSettled([reader.getResult(id), reader.getResult(id)]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(Date.now() - t0).toBeLessThan(2_000);
      proxy.state.frozen = false;
      expect((await reader.getResult(id))?.id).toBe(id);
    });

    it("超时断开时对端不响应 FIN:旧套接字也被强制关闭,连续超时不累积,恢复后照常读到终态", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(300);
      const track = trackClientSockets(proxy.port);
      await reader.getResult(id); // 建好连接
      expect(track.sockets).toHaveLength(1);

      proxy.state.frozen = true;
      proxy.state.ignoreFin = true;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await expect(reader.getResult(id)).rejects.toBeInstanceOf(ResultReadTimeout);
        expect(Date.now() - t0).toBeLessThan(2_000);
        // 返回时用过的套接字都已真正关闭 —— 只发 FIN(end)的话对端不回应,它会一直半开着
        expect(track.alive()).toBe(0);
      }
      expect(track.sockets.length).toBeGreaterThanOrEqual(3);

      proxy.state.frozen = false;
      await db
        .update(runsTable)
        .set({ status: "success", finalText: "完成" })
        .where(eq(runsTable.id, id));
      expect(await reader.getResult(id)).toMatchObject({ status: "success", finalText: "完成" });
      expect(track.alive()).toBe(1); // 只剩恢复后新建的那一条
    });

    it("终态兜底接在它上面:数据库卡死期间不积压连接,恢复后照常收尾", async () => {
      const id = await newRun();
      const { proxy, reader } = await readerViaProxy(200);
      await reader.getResult(id);
      proxy.state.frozen = true;
      proxy.state.peak = proxy.state.open;

      let settled: unknown;
      const stop = watchTerminal(
        reader,
        id,
        (e) => {
          settled = e;
        },
        50,
      );
      try {
        await sleep(1_500); // 卡死期间兜底照常一轮轮重试
        expect(settled).toBeUndefined();
        expect(proxy.state.peak).toBeLessThanOrEqual(1);

        proxy.state.frozen = false;
        await db
          .update(runsTable)
          .set({ status: "success", finalText: "完成" })
          .where(eq(runsTable.id, id));
        const deadline = Date.now() + 5_000;
        while (!settled && Date.now() < deadline) await sleep(50);
        expect(settled).toMatchObject({ kind: "result", status: "success", summary: "完成" });
      } finally {
        stop();
      }
    });
  });
}
