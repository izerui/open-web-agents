// 运行记录查询对真实 MySQL 的测试。未配置 OWA_TEST_DATABASE_URL 时跳过并说明。

import { createDb } from "@/lib/db/client";
import { MysqlRunQuery } from "@/lib/modules/run/adapters/mysql-run-query";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const URL_ = process.env.OWA_TEST_DATABASE_URL;

if (!URL_) {
  console.warn("[skip] MysqlRunQuery 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
  describe.skip("MysqlRunQuery(未配置 OWA_TEST_DATABASE_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  const dbName = new URL(URL_).pathname.replace(/^\//, "");
  const { db, pool } = createDb(URL_);
  const runs = new MysqlRunRepo(db);
  const sessions = new MysqlSessionRepo(db);
  const query = new MysqlRunQuery(db);

  beforeEach(async () => {
    await runs._truncate(dbName);
    await sessions._truncate(dbName);
  });
  afterAll(async () => {
    await runs._truncate(dbName);
    await sessions._truncate(dbName);
    await pool.end();
  });

  describe("MysqlRunQuery", () => {
    it("按计费账号筛选:自己工作台的对话 + 自己 Key 发起的调用,不含别人的", async () => {
      await sessions.create({ id: "web1", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
      await sessions.create({
        id: "inv1",
        agentId: "a",
        workspaceDir: "/w",
        callerApiKeyId: "k1",
        billingUserId: "u1",
        unattended: true,
      });
      await sessions.create({ id: "other", agentId: "a", workspaceDir: "/w", ownerId: "u2" });
      await runs.create({ id: "r-web", sessionId: "web1", prompt: "你好" });
      await runs.create({ id: "r-inv", sessionId: "inv1", prompt: "{}" });
      await runs.create({ id: "r-other", sessionId: "other", prompt: "x" });

      const mine = await query.list({ billingUserId: "u1", limit: 50 });
      expect(mine.items.map((r) => r.id).sort()).toEqual(["r-inv", "r-web"]);
      expect(mine.items.find((r) => r.id === "r-inv")?.source).toBe("invoke");

      const byKey = await query.list({ callerApiKeyId: "k1", limit: 50 });
      expect(byKey.items.map((r) => r.id)).toEqual(["r-inv"]);

      const onlyInvoke = await query.list({ billingUserId: "u1", sources: ["invoke"], limit: 50 });
      expect(onlyInvoke.items.map((r) => r.id)).toEqual(["r-inv"]);
    });

    it("游标分页:翻完所有页不漏不重(含同一秒内创建的多条)", async () => {
      await sessions.create({ id: "s", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
      const ids = Array.from({ length: 7 }, (_, i) => `r${i}`);
      for (const id of ids) await runs.create({ id, sessionId: "s", prompt: id });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await query.list({ billingUserId: "u1", limit: 3, cursor });
        seen.push(...r.items.map((x) => x.id));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual(ids.sort());
    });

    it("按状态筛选,详情带归属信息供鉴权", async () => {
      await sessions.create({ id: "s", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
      await runs.create({ id: "ok", sessionId: "s", prompt: "p" });
      await runs.create({ id: "bad", sessionId: "s", prompt: "p" });
      await runs.cancel("bad");
      const cancelled = await query.list({
        billingUserId: "u1",
        statuses: ["cancelled"],
        limit: 10,
      });
      expect(cancelled.items.map((r) => r.id)).toEqual(["bad"]);
      const d = await query.detail("ok");
      expect(d?.ownership.ownerId).toBe("u1");
      expect(d?.prompt).toBe("p");
      expect(await query.detail("nope")).toBeNull();
    });
  });
}
