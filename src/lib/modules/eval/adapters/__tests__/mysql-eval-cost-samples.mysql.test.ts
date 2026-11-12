// 评测花费预估的样本(gaps A9)对真实 MySQL 的测试。
// 未配置 OWA_TEST_DATABASE_URL 时跳过。只增删本用例自己造的行(id 带随机前缀),不清表。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EVAL_ESTIMATE_SAMPLES } from "../../domain/cost-estimate";
import { MysqlEvalCostSamples } from "../mysql-eval-cost-samples";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 评测花费样本 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("MysqlEvalCostSamples(未配置测试库,已跳过)", () => {
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
  const MODEL = `m-${tag}`;

  async function session(sid: string, aid: string, source = "web") {
    await db.execute(
      sql`INSERT INTO sessions (id, agent_id, owner_id, workspace_dir, source)
          VALUES (${id(sid)}, ${id(aid)}, 'u', '/w', ${source})`,
    );
  }
  let seq = 0;
  async function run(
    sid: string,
    charged: string,
    opts: { ageMs?: number; model?: string; state?: string } = {},
  ) {
    seq += 1;
    const rid = id(`r${seq}`);
    const at = new Date(Date.now() - (opts.ageMs ?? seq * 1000));
    const cost = JSON.stringify({ pricing: { binding: { mainRef: opts.model ?? MODEL } } });
    await db.execute(
      sql`INSERT INTO runs (id, session_id, status, prompt, cost, created_at)
          VALUES (${rid}, ${id(sid)}, 'success', 'p', ${cost}, ${at})`,
    );
    await db.execute(
      sql`INSERT INTO run_charges (run_id, account_id, mode, reserved_micro, reservation_ids, charged_micro, state, created_at)
          VALUES (${rid}, 'u', 'live', '0', '[]', ${charged}, ${opts.state ?? "settled"}, ${at})`,
    );
  }

  afterEach(async () => {
    const like = `${tag}-%`;
    await db.execute(sql`DELETE FROM run_charges WHERE run_id LIKE ${like}`);
    await db.execute(sql`DELETE FROM runs WHERE id LIKE ${like}`);
    await db.execute(sql`DELETE FROM sessions WHERE id LIKE ${like}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("MysqlEvalCostSamples(真实 MySQL)", () => {
    it("本智能体的样本优先;不足时用同模型的其它运行补齐", async () => {
      await session("mine", "a1");
      await session("other", "a2");
      await run("mine", "1000");
      await run("mine", "2000");
      await run("other", "9000");
      const got = await new MysqlEvalCostSamples(db).recentChargedMicro(id("a1"), MODEL);
      expect(got.slice(0, 2).sort()).toEqual(["1000", "2000"]);
      expect(got).toContain("9000");
    });

    it("本智能体样本已够时不取别处的", async () => {
      await session("mine", "a1");
      await session("other", "a2");
      for (let i = 0; i < EVAL_ESTIMATE_SAMPLES; i++) await run("mine", "1000");
      await run("other", "9000");
      const got = await new MysqlEvalCostSamples(db).recentChargedMicro(id("a1"), MODEL);
      expect(got).toHaveLength(EVAL_ESTIMATE_SAMPLES);
      expect(got).not.toContain("9000");
    });

    it("不算设计器会话、别的模型、还在冻结的、30 天以前的", async () => {
      await session("mine", "a1");
      await session("design", "a1", "design");
      await run("design", "111");
      await run("mine", "222", { model: "other-model" });
      await run("mine", "333", { state: "open" });
      await run("mine", "444", { ageMs: 40 * DAY });
      const got = await new MysqlEvalCostSamples(db).recentChargedMicro(id("a1"), MODEL);
      expect(got).toEqual([]);
    });
  });
}
