// 评测仓储在真实 MySQL 上的行为。未配置 OWA_TEST_DATABASE_URL 时跳过。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { evalCases, evalResults, evalRuns } from "@/lib/db/schema";
import { MysqlEvalRepo } from "@/lib/modules/eval/adapters/mysql-eval-repo";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 评测仓储的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("评测仓储(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlEvalRepo(db);
  const agentId = `a-eval-${randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    const runs = await repo.listRuns(agentId, 100);
    for (const r of runs) await db.delete(evalResults).where(eq(evalResults.evalRunId, r.id));
    await db.delete(evalRuns).where(eq(evalRuns.agentId, agentId));
    await db.delete(evalCases).where(eq(evalCases.agentId, agentId));
    await pool.end();
  });

  describe("MysqlEvalRepo(真实 MySQL)", () => {
    it("用例增删改查;输入与断言原样往返(含对象输入)", async () => {
      const id = randomUUID();
      await repo.createCase({
        id,
        agentId,
        name: "合同",
        input: { contract: "甲方……", n: 3 },
        assertions: { contains: ["完成"], fieldEquals: [{ path: "a.b", value: [1, 2] }] },
        createdBy: "u1",
      });
      expect(await repo.getCase(id)).toMatchObject({
        input: { contract: "甲方……", n: 3 },
        assertions: { contains: ["完成"], fieldEquals: [{ path: "a.b", value: [1, 2] }] },
      });
      await repo.updateCase(id, { name: "合同2", input: "文本", assertions: {} });
      expect(await repo.getCase(id)).toMatchObject({
        name: "合同2",
        input: "文本",
        assertions: {},
      });
      expect((await repo.listCases(agentId)).map((c) => c.id)).toEqual([id]);
      await repo.deleteCase(id);
      expect(await repo.getCase(id)).toBeNull();
    });

    it("同一秒内连建的用例按建立顺序列出(不按随机 id)", async () => {
      const ids = ["zz-later-id", "aa-earlier-id"].map((p) => `${p}-${randomUUID().slice(0, 6)}`);
      for (const [i, id] of ids.entries()) {
        await repo.createCase({ id, agentId, name: `第${i + 1}个`, input: "x", assertions: {} });
      }
      const listed = (await repo.listCases(agentId))
        .map((c) => c.id)
        .filter((x) => ids.includes(x));
      expect(listed).toEqual(ids);
      for (const id of ids) await repo.deleteCase(id);
    });

    it("评测与结果同一事务落库;判分只改 pending;收尾只改 running", async () => {
      const runId = randomUUID();
      await repo.createRun(
        {
          id: runId,
          agentId,
          agentVersion: 2,
          configHash: "h".repeat(64),
          status: "running",
          total: 2,
          passed: 0,
          failed: 0,
          startedBy: "u1",
        },
        [
          {
            evalRunId: runId,
            caseId: "c1",
            caseName: "一",
            input: "x",
            assertions: {},
            taskId: "t1",
            status: "pending",
          },
          {
            evalRunId: runId,
            caseId: "c2",
            caseName: "二",
            input: "y",
            assertions: {},
            status: "error",
            failures: ["入参不符"],
          },
        ],
      );
      expect(await repo.getRun(runId)).toMatchObject({
        agentVersion: 2,
        configHash: "h".repeat(64),
        status: "running",
        total: 2,
      });

      const output = {
        status: "success",
        text: "回复正文",
        textTruncated: true,
        structured: { verdict: "pass", score: 0.9, issues: [{ level: "high" }] },
      };
      await repo.gradeResult(runId, "c1", {
        status: "passed",
        failures: [],
        output,
        costMicroUsd: 12_345,
        durationMs: 900,
      });
      // 已有结论的不会被再次判分改掉
      await repo.gradeResult(runId, "c1", {
        status: "failed",
        failures: ["x"],
        output: { status: "failed", text: "后来的" },
      });
      await repo.gradeResult(runId, "c2", { status: "passed", failures: [] });
      const res = await repo.results(runId);
      expect(res.find((r) => r.caseId === "c1")).toMatchObject({
        status: "passed",
        costMicroUsd: 12_345,
        durationMs: 900,
      });
      // 快照原样往返;后来的重复判分不会改掉它
      expect(res.find((r) => r.caseId === "c1")?.output).toEqual(output);
      // 没能发起运行、建评测时就判了 error 的用例没有快照
      expect(res.find((r) => r.caseId === "c2")?.output).toBeUndefined();
      expect(res.find((r) => r.caseId === "c2")).toMatchObject({
        status: "error",
        failures: ["入参不符"],
      });

      await repo.finishRun(runId, { passed: 1, failed: 1 });
      await repo.finishRun(runId, { passed: 0, failed: 2 }); // 已收尾,不再改
      expect(await repo.getRun(runId)).toMatchObject({ status: "done", passed: 1, failed: 1 });
      expect((await repo.listRuns(agentId, 10)).map((r) => r.id)).toContain(runId);
    });

    it("latestByConfig:每个内容摘要各取最近一次(不论是否结束);用例摘要原样往返", async () => {
      const mk = async (id: string, configHash: string, status: "running" | "done") => {
        await repo.createRun(
          {
            id,
            agentId,
            configHash,
            casesHash: `cases-${id}`,
            status,
            total: 1,
            passed: status === "done" ? 1 : 0,
            failed: 0,
            startedBy: "u",
          },
          [],
        );
        await new Promise((ok) => setTimeout(ok, 5));
      };
      const tag = randomUUID().slice(0, 8);
      await mk(`${tag}-1`, `h1-${tag}`, "done");
      await mk(`${tag}-2`, `h1-${tag}`, "running");
      await mk(`${tag}-3`, `h2-${tag}`, "done");
      const got = await repo.latestByConfig(agentId, [`h1-${tag}`, `h2-${tag}`, `h3-${tag}`]);
      expect(got.get(`h1-${tag}`)).toMatchObject({ id: `${tag}-2`, status: "running" });
      expect(got.get(`h2-${tag}`)).toMatchObject({ id: `${tag}-3`, casesHash: `cases-${tag}-3` });
      expect(got.has(`h3-${tag}`)).toBe(false);
      // 别的智能体同摘要的评测不算
      expect((await repo.latestByConfig("other-agent", [`h1-${tag}`])).size).toBe(0);
    });
  });
}
