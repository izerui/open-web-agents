// MysqlRunQuery.latestBySessions 对真实 MySQL 的测试。未配置 OWA_TEST_DATABASE_URL 时跳过。
// 只增删本用例自己造的行(id 带随机前缀),不清表。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { MysqlRunQuery } from "@/lib/modules/run/adapters/mysql-run-query";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] latestBySessions 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("latestBySessions(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const id = (s: string) => `${tag}-${s}`;

  async function run(rid: string, sid: string, ageMs: number, status: string, text?: string) {
    await db.execute(
      sql`INSERT INTO runs (id, session_id, status, prompt, final_text, created_at)
          VALUES (${id(rid)}, ${id(sid)}, ${status}, ${`问题 ${rid}`}, ${text ?? null},
                  ${new Date(Date.now() - ageMs)})`,
    );
  }

  afterEach(async () => {
    await db.execute(sql`DELETE FROM runs WHERE id LIKE ${`${tag}-%`}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("MysqlRunQuery.latestBySessions(真实 MySQL)", () => {
    it("每个会话只取最近一次运行,带输入与回答的摘要", async () => {
      await run("a1", "s1", 60_000, "success", "旧回答");
      await run("a2", "s1", 0, "running");
      await run("b1", "s2", 5_000, "success", "x".repeat(600));

      const latest = await new MysqlRunQuery(db).latestBySessions([
        id("s1"),
        id("s2"),
        id("never"),
      ]);
      expect(latest.size).toBe(2);
      expect(latest.get(id("s1"))).toMatchObject({ status: "running", promptPreview: "问题 a2" });
      expect(latest.get(id("s1"))?.replyPreview).toBeUndefined();
      expect(latest.get(id("s2"))?.status).toBe("success");
      expect(latest.get(id("s2"))?.replyPreview).toHaveLength(400);
      expect(latest.has(id("never"))).toBe(false);
    });

    it("空列表不查库", async () => {
      expect((await new MysqlRunQuery(db).latestBySessions([])).size).toBe(0);
    });
  });
}
