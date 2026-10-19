// 计费口径对真实 MySQL 的测试。未配置 OWA_TEST_DATABASE_URL 时跳过并说明。
//
// 守的是这条回归:额度统计曾按 sessions.owner_id 聚合,API Key 建的会话
// 没有 owner,于是它们的花费不计入任何人 —— 签发 key 的账号额度永远拦不住接口调用。

import { createDb } from "@/lib/db/client";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { MysqlUsageRepo } from "@/lib/modules/usage/adapters/mysql-usage-repo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const URL_ = process.env.OWA_TEST_DATABASE_URL;

if (!URL_) {
  console.warn("[skip] MysqlUsageRepo 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
  describe.skip("MysqlUsageRepo(真实 MySQL)(未配置 OWA_TEST_DATABASE_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  const dbName = new URL(URL_).pathname.replace(/^\//, "");
  const { db, pool } = createDb(URL_);
  const runs = new MysqlRunRepo(db);
  const sessions = new MysqlSessionRepo(db);
  const usage = new MysqlUsageRepo(db);

  beforeEach(async () => {
    await runs._truncate(dbName);
    await sessions._truncate(dbName);
  });
  afterAll(async () => {
    await runs._truncate(dbName);
    await sessions._truncate(dbName);
    await pool.end();
  });

  async function spend(sessionId: string, runId: string, usd: number) {
    await runs.create({ id: runId, sessionId, prompt: "x" });
    await runs.saveResult(runId, { cost: { usd, input: 1, output: 1 } });
  }

  describe("MysqlUsageRepo 计费口径", () => {
    it("API Key 会话的花费计入签发人,而不是谁都不算", async () => {
      await sessions.create({ id: "web", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
      await sessions.create({
        id: "api",
        agentId: "a",
        workspaceDir: "/w",
        callerApiKeyId: "k1",
        billingUserId: "u1",
      });
      await spend("web", "r1", 1);
      await spend("api", "r2", 2);

      const costs = await usage.costByOwner(0, "u1");
      expect(costs.get("u1")).toBe(3_000_000);
      expect((await usage.list({ ownerId: "u1", since: 0 })).length).toBe(2);
    });

    it("别人的会话不算进来", async () => {
      await sessions.create({ id: "mine", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
      await sessions.create({ id: "other", agentId: "a", workspaceDir: "/w", ownerId: "u2" });
      await spend("mine", "r1", 1);
      await spend("other", "r2", 5);
      expect((await usage.costByOwner(0, "u1")).get("u1")).toBe(1_000_000);
    });
  });
}
