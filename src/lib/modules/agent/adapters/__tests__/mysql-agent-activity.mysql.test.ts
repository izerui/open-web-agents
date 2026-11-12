// 工作室列表的活跃度(近 N 天运行数、更新时间)对真实 MySQL 的测试。
// 未配置 OWA_TEST_DATABASE_URL 时跳过。只增删本用例自己造的行(id 带随机前缀),不清表。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MysqlAgentActivity } from "../mysql-agent-activity";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 智能体活跃度 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("MysqlAgentActivity(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const id = (s: string) => `${tag}-${s}`;
  const DAY = 86_400_000;

  async function agent(aid: string) {
    await db.execute(
      sql`INSERT INTO agents (id, owner_id, name, config) VALUES (${id(aid)}, 'u', ${aid}, '{}')`,
    );
  }
  async function session(sid: string, aid: string) {
    await db.execute(
      sql`INSERT INTO sessions (id, agent_id, owner_id, workspace_dir, source)
          VALUES (${id(sid)}, ${id(aid)}, 'u', '/w', 'web')`,
    );
  }
  let seq = 0;
  async function run(sid: string, ageMs: number) {
    seq += 1;
    await db.execute(
      sql`INSERT INTO runs (id, session_id, status, prompt, created_at)
          VALUES (${id(`r${seq}`)}, ${id(sid)}, 'success', 'p', ${new Date(Date.now() - ageMs)})`,
    );
  }

  afterEach(async () => {
    const like = `${tag}-%`;
    await db.execute(sql`DELETE FROM runs WHERE id LIKE ${like}`);
    await db.execute(sql`DELETE FROM sessions WHERE id LIKE ${like}`);
    await db.execute(sql`DELETE FROM agents WHERE id LIKE ${like}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("MysqlAgentActivity(真实 MySQL)", () => {
    it("只数窗口内的运行(跨多个会话);没有运行的智能体也回来,计 0 并带更新时间", async () => {
      await agent("busy");
      await agent("quiet");
      await session("s1", "busy");
      await session("s2", "busy");
      await run("s1", 1000);
      await run("s2", 2 * DAY);
      await run("s2", 10 * DAY);
      const since = Date.now() - 7 * DAY;
      const got = await new MysqlAgentActivity(db).of([id("busy"), id("quiet")], since);
      expect(got.get(id("busy"))?.runs).toBe(2);
      expect(got.get(id("quiet"))?.runs).toBe(0);
      expect(got.get(id("quiet"))?.updatedAt).toBeGreaterThan(Date.now() - DAY);
    });

    it("空列表不查库", async () => {
      expect((await new MysqlAgentActivity(db).of([], 0)).size).toBe(0);
    });
  });
}
