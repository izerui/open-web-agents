// 有时限的结果读取在真实 MySQL 上:连接卡死(网络不通而 TCP 没断开)时,
// 超时要真正结束底层查询(断开那条连接),而不是只是不再等 —— 否则卡住的连接被放回池里,
// 之后的查询一起卡死,终态兜底永远收不了尾。
//
// 用一个可"冻结"的 TCP 代理模拟卡死:冻结时两头都不转发,连接保持打开。

import { randomUUID } from "node:crypto";
import net from "node:net";
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

/**
 * TCP 代理:frozen 时两头都不转发(连接保持打开)。
 * stallAuth 时新连接只放过服务器的第一段数据(握手问候),之后两个方向都丢弃 ——
 * 停在"问候之后、认证完成之前";服务器自己的 connect_timeout 报错也到不了客户端,和真实断网一样。
 * 记录当前与峰值打开的连接数、送达客户端的服务器字节数。
 */
async function startFreezeProxy(target: URL) {
  const state = {
    frozen: false,
    stallAuth: false,
    /** 收到客户端的 FIN(半关闭)后不回应、不关闭 —— 对端不响应 FIN 的情形 */
    ignoreFin: false,
    open: 0,
    peak: 0,
    serverBytes: 0,
  };
  const sockets = new Set<net.Socket>();
  // allowHalfOpen:收到客户端 FIN 时不自动回 FIN,由下面按模式决定
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect(Number(target.port || 3306), target.hostname);
    sockets.add(client);
    state.open++;
    state.peak = Math.max(state.peak, state.open);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      state.open--;
      sockets.delete(client);
      client.destroy();
      upstream.destroy();
    };
    // 这条连接是否卡在问候之后(建立时处于 stallAuth 才算)
    const stalled = state.stallAuth;
    let greeted = false;
    client.on("data", (d) => {
      if (!state.frozen && !stalled) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (state.frozen || (stalled && greeted)) return;
      greeted = true;
      state.serverBytes += d.length;
      client.write(d);
    });
    client.on("close", close);
    client.on("error", close);
    // 客户端半关闭:正常时随之关闭;ignoreFin 时什么也不做,客户端那条套接字若只是 end() 就一直半开着
    client.on("end", () => {
      if (!state.ignoreFin) close();
    });
    // 卡住期间服务器那头关闭(如它自己的 connect_timeout 到期)也传不到客户端 —— 真实断网时同样如此;
    // 客户端这头保持打开,直到客户端自己断开
    const upstreamGone = () => {
      if (!(stalled || state.frozen)) close();
    };
    upstream.on("close", upstreamGone);
    upstream.on("error", upstreamGone);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const url = new URL(target.toString());
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    state,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 记下读取源(经 mysql2)建立的每条客户端套接字 —— 从代理那头看,客户端 end() 与 destroy()
 * 都只是一个 FIN,分不出来;要验证"旧套接字真的关闭了",得看客户端这一侧。
 */
const clientSockets: net.Socket[] = [];
const realConnect = net.connect;
function trackClientSockets(port: number) {
  vi.spyOn(net, "connect").mockImplementation(((...args: Parameters<typeof net.connect>) => {
    const socket = (realConnect as (...a: unknown[]) => net.Socket)(...args);
    const opts = args[0] as { port?: number } | number;
    if ((typeof opts === "number" ? opts : opts?.port) === port) clientSockets.push(socket);
    return socket;
  }) as typeof net.connect);
}
const aliveClientSockets = () => clientSockets.filter((s) => !s.closed).length;

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
    clientSockets.length = 0;
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
      trackClientSockets(Number(new URL(proxy.url).port));
      await reader.getResult(id); // 建好连接
      expect(clientSockets).toHaveLength(1);

      proxy.state.frozen = true;
      proxy.state.ignoreFin = true;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await expect(reader.getResult(id)).rejects.toBeInstanceOf(ResultReadTimeout);
        expect(Date.now() - t0).toBeLessThan(2_000);
        // 返回时用过的套接字都已真正关闭 —— 只发 FIN(end)的话对端不回应,它会一直半开着
        expect(aliveClientSockets()).toBe(0);
      }
      expect(clientSockets.length).toBeGreaterThanOrEqual(3);

      proxy.state.frozen = false;
      await db
        .update(runsTable)
        .set({ status: "success", finalText: "完成" })
        .where(eq(runsTable.id, id));
      expect(await reader.getResult(id)).toMatchObject({ status: "success", finalText: "完成" });
      expect(aliveClientSockets()).toBe(1); // 只剩恢复后新建的那一条
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
