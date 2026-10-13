// markWorkspacePurged 对真实 MySQL 的测试:判定与写入在同一条 UPDATE 里,
// 扫描之后才出现的活动、正在执行的运行都要挡住清理。未配置 OWA_TEST_DATABASE_URL 时跳过。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] markWorkspacePurged 的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("markWorkspacePurged(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const sessions = new MysqlSessionRepo(db);
  const runs = new MysqlRunRepo(db);
  afterAll(async () => {
    await pool.end();
  });
  const sid = () => `p${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mk = async () => {
    const id = sid();
    await sessions.create({ id, agentId: "a", workspaceDir: `/ws/${id}`, ownerId: "u" });
    return id;
  };

  describe("markWorkspacePurged(真实 MySQL)", () => {
    it("截止时刻之前创建、之后没有活动:标记成功并记下时刻", async () => {
      const id = await mk();
      await sleep(1100); // timestamp 精度到秒
      const now = Date.now();
      expect(await sessions.markWorkspacePurged(id, { cutoffMs: now, nowMs: now })).toBe(true);
      expect((await sessions.get(id))?.workspacePurgedAt).toBe(now);
    });

    it("截止时刻之后有新运行(扫描之后有人发起了新一轮):不标记", { timeout: 10_000 }, async () => {
      const id = await mk();
      await sleep(1100);
      const cutoff = Date.now();
      await sleep(1100);
      await runs.create({ id: sid(), sessionId: id, prompt: "新一轮" });
      expect(await sessions.markWorkspacePurged(id, { cutoffMs: cutoff, nowMs: Date.now() })).toBe(
        false,
      );
      expect((await sessions.get(id))?.workspacePurgedAt).toBeUndefined();
    });

    it("有运行正在执行(租约有效),即使它很早以前就创建了:不标记", { timeout: 10_000 }, async () => {
      const id = await mk();
      const runId = sid();
      await runs.create({ id: runId, sessionId: id, prompt: "长任务" });
      // 直接把这一条置为 running、租约一分钟 —— 不用 claimNext,免得认领到测试库里别人的运行
      await db.execute(
        sql`UPDATE runs SET status = 'running', lease_until = ${Date.now() + 60_000} WHERE id = ${runId}`,
      );
      await sleep(1100);
      const now = Date.now();
      expect(await sessions.markWorkspacePurged(id, { cutoffMs: now, nowMs: now })).toBe(false);
      // 租约过期后(worker 已失联)不再挡
      await db.execute(sql`UPDATE runs SET lease_until = ${now - 1} WHERE id = ${runId}`);
      expect(await sessions.markWorkspacePurged(id, { cutoffMs: now, nowMs: now })).toBe(true);
    });
  });
}
