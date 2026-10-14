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
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

/** TCP 代理:frozen 时两头都不转发(连接保持打开);记录当前与峰值打开的连接数 */
async function startFreezeProxy(target: URL) {
  const state = { frozen: false, open: 0, peak: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
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
    client.on("data", (d) => {
      if (!state.frozen) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (!state.frozen) client.write(d);
    });
    for (const s of [client, upstream]) {
      s.on("close", close);
      s.on("error", close);
    }
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

  /** 经代理连库的读取源:连接池只有 1 条连接 —— 卡住的连接若没被真正释放,之后一条都读不了 */
  async function readerViaProxy(timeoutMs: number) {
    const proxy = await startFreezeProxy(new URL(TEST_DB_URL as string));
    const { pool: readerPool } = createDb(proxy.url, {
      connectionLimit: 1,
      connectTimeoutMs: 300,
    });
    cleanups.push(async () => {
      proxy.state.frozen = false;
      await Promise.race([readerPool.end(), sleep(1_000)]);
      await proxy.close();
    });
    return { proxy, reader: new BoundedResultReader(readerPool, timeoutMs, 1_000) };
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
        // 有上限:查询时限 300ms / 建连时限 300ms,加上等套接字关闭
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
