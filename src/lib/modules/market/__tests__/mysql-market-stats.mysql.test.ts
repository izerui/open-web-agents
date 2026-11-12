// 市场统计(作者、近 90 天使用次数、近 50 次成功运行的平均实扣)对真实 MySQL 的测试。
// 未配置 OWA_TEST_DATABASE_URL 时跳过。只增删本用例自己造的行(id 带随机前缀),不清表。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MysqlMarketStats } from "../adapters/mysql-market-stats";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 市场统计 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("MysqlMarketStats(未配置测试库,已跳过)", () => {
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

  async function user(uid: string, email: string) {
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${id(uid)}, ${email}, 'h')`,
    );
  }
  async function session(sid: string, agentId: string, source = "web") {
    await db.execute(
      sql`INSERT INTO sessions (id, agent_id, owner_id, workspace_dir, source)
          VALUES (${id(sid)}, ${id(agentId)}, 'u', '/w', ${source})`,
    );
  }
  let seq = 0;
  async function run(
    sid: string,
    opts: { ageMs?: number; status?: string; charged?: string; state?: string },
  ) {
    seq += 1;
    const rid = id(`r${seq}`);
    const at = new Date(Date.now() - (opts.ageMs ?? 0));
    await db.execute(
      sql`INSERT INTO runs (id, session_id, status, prompt, created_at)
          VALUES (${rid}, ${id(sid)}, ${opts.status ?? "success"}, 'p', ${at})`,
    );
    if (opts.charged !== undefined) {
      await db.execute(
        sql`INSERT INTO run_charges (run_id, account_id, mode, reserved_micro, reservation_ids, charged_micro, state, created_at)
            VALUES (${rid}, 'u', 'live', '0', '[]', ${opts.charged}, ${opts.state ?? "settled"}, ${at})`,
      );
    }
  }

  afterEach(async () => {
    const like = `${tag}-%`;
    await db.execute(sql`DELETE FROM run_charges WHERE run_id LIKE ${like}`);
    await db.execute(sql`DELETE FROM runs WHERE id LIKE ${like}`);
    await db.execute(sql`DELETE FROM sessions WHERE id LIKE ${like}`);
    await db.execute(sql`DELETE FROM users WHERE id LIKE ${like}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("MysqlMarketStats(真实 MySQL)", () => {
    it("作者取邮箱前缀;使用次数只算近 90 天、不含评测与设计器会话", async () => {
      await user("owner", `${tag}.author@x.test`);
      await session("s1", "a1");
      await session("s-eval", "a1", "eval");
      await session("s-design", "a1", "design");
      await run("s1", {});
      await run("s1", { status: "failed" });
      await run("s1", { ageMs: 91 * DAY });
      await run("s-eval", {});
      await run("s-design", {});

      const stats = await new MysqlMarketStats(db).forAgents([
        { id: id("a1"), ownerId: id("owner") },
        { id: id("none"), ownerId: id("ghost") },
      ]);
      expect(stats.get(id("a1"))).toEqual({
        author: `${tag}.author`,
        useCount: 2,
        avgCredits: null,
      });
      expect(stats.get(id("none"))).toEqual({ author: null, useCount: 0, avgCredits: null });
    });

    it("平均实扣只取最近 50 次成功且已结算的运行", async () => {
      await user("owner", `${tag}.b@x.test`);
      await session("s1", "a1");
      // 更早的 5 次花费很高,应被最近 50 次挤出窗口
      for (let i = 0; i < 5; i++) {
        await run("s1", { ageMs: 10 * DAY + i, charged: "100000000" });
      }
      for (let i = 0; i < 50; i++) {
        await run("s1", { ageMs: i * 1000, charged: "2000000" });
      }
      // 失败的、还在冻结中的不计入
      await run("s1", { status: "failed", charged: "900000000" });
      await run("s1", { charged: "900000000", state: "open" });

      const stats = await new MysqlMarketStats(db).forAgents([
        { id: id("a1"), ownerId: id("owner") },
      ]);
      expect(stats.get(id("a1"))?.avgCredits).toBeCloseTo(2);
      expect(stats.get(id("a1"))?.useCount).toBe(57);
    });

    it("只看近 90 天:窗口外的旧运行既不算使用次数,也不进平均实扣(查询按时间截断,不扫全部历史)", async () => {
      await user("owner", `${tag}.c@x.test`);
      await session("s1", "a1");
      await run("s1", { ageMs: 120 * DAY, charged: "100000000" });
      await run("s1", { ageMs: 1000, charged: "2000000" });
      const stats = await new MysqlMarketStats(db).forAgents([
        { id: id("a1"), ownerId: id("owner") },
      ]);
      expect(stats.get(id("a1"))?.useCount).toBe(1);
      expect(stats.get(id("a1"))?.avgCredits).toBeCloseTo(2);
    });

    it("空列表不查库", async () => {
      expect((await new MysqlMarketStats(db).forAgents([])).size).toBe(0);
    });
  });
}
