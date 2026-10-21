import type { Db } from "@/lib/db/client";
import { evalCases, evalResults, evalRuns } from "@/lib/db/schema";
import type { EvalAssertions, EvalOutput } from "@/lib/modules/eval/domain/assertions";
import type { EvalCase, EvalRepo, EvalResult, EvalRun } from "@/lib/modules/eval/ports";
import { and, asc, desc, eq } from "drizzle-orm";

type CaseRow = typeof evalCases.$inferSelect;
type RunRow = typeof evalRuns.$inferSelect;
type ResultRow = typeof evalResults.$inferSelect;

const toCase = (r: CaseRow): EvalCase => ({
  id: r.id,
  agentId: r.agentId,
  name: r.name,
  input: r.input,
  assertions: (r.assertions ?? {}) as EvalAssertions,
  createdBy: r.createdBy ?? undefined,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

const toRun = (r: RunRow): EvalRun => ({
  id: r.id,
  agentId: r.agentId,
  agentVersion: r.agentVersion ?? undefined,
  configHash: r.configHash ?? undefined,
  casesHash: r.casesHash ?? undefined,
  status: r.status === "done" ? "done" : "running",
  total: r.total,
  passed: r.passed,
  failed: r.failed,
  startedBy: r.startedBy,
  createdAt: r.createdAt.getTime(),
  finishedAt: r.finishedAt?.getTime(),
});

const toResult = (r: ResultRow): EvalResult => ({
  evalRunId: r.evalRunId,
  caseId: r.caseId,
  caseName: r.caseName,
  input: r.input,
  assertions: (r.assertions ?? {}) as EvalAssertions,
  taskId: r.taskId ?? undefined,
  sessionId: r.sessionId ?? undefined,
  status: r.status as EvalResult["status"],
  failures: (r.failures as string[] | null) ?? undefined,
  output: (r.output as EvalOutput | null) ?? undefined,
  costMicroUsd: r.costMicroUsd ?? undefined,
  durationMs: r.durationMs ?? undefined,
  gradedAt: r.gradedAt?.getTime(),
});

export class MysqlEvalRepo implements EvalRepo {
  constructor(private readonly db: Db) {}

  async listCases(agentId: string): Promise<EvalCase[]> {
    const rows = await this.db
      .select()
      .from(evalCases)
      .where(eq(evalCases.agentId, agentId))
      .orderBy(asc(evalCases.createdAt), asc(evalCases.id))
      .limit(500);
    return rows.map(toCase);
  }

  async getCase(id: string): Promise<EvalCase | null> {
    const rows = await this.db.select().from(evalCases).where(eq(evalCases.id, id)).limit(1);
    return rows[0] ? toCase(rows[0]) : null;
  }

  async createCase(c: Omit<EvalCase, "createdAt" | "updatedAt">): Promise<EvalCase> {
    await this.db.insert(evalCases).values({
      id: c.id,
      agentId: c.agentId,
      name: c.name,
      input: c.input,
      assertions: c.assertions,
      createdBy: c.createdBy ?? null,
      // 显式写毫秒时刻:列默认值 now() 只到秒,同一秒建的用例会按随机 id 排序
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const saved = await this.getCase(c.id);
    if (!saved) throw new Error(`eval case insert failed: ${c.id}`);
    return saved;
  }

  async updateCase(
    id: string,
    patch: { name: string; input: unknown; assertions: EvalAssertions },
  ): Promise<void> {
    await this.db
      .update(evalCases)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(evalCases.id, id));
  }

  async deleteCase(id: string): Promise<void> {
    await this.db.delete(evalCases).where(eq(evalCases.id, id));
  }

  async createRun(run: Omit<EvalRun, "createdAt">, results: EvalResult[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(evalRuns).values({
        id: run.id,
        agentId: run.agentId,
        agentVersion: run.agentVersion ?? null,
        configHash: run.configHash ?? null,
        casesHash: run.casesHash ?? null,
        status: run.status,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        startedBy: run.startedBy,
        createdAt: new Date(),
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      });
      if (results.length > 0) {
        await tx.insert(evalResults).values(
          results.map((r) => ({
            evalRunId: r.evalRunId,
            caseId: r.caseId,
            caseName: r.caseName,
            input: r.input,
            assertions: r.assertions,
            taskId: r.taskId ?? null,
            sessionId: r.sessionId ?? null,
            status: r.status,
            failures: r.failures ?? null,
            output: r.output ?? null,
            gradedAt: r.gradedAt ? new Date(r.gradedAt) : null,
          })),
        );
      }
    });
  }

  async getRun(id: string): Promise<EvalRun | null> {
    const rows = await this.db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listRuns(agentId: string, limit: number): Promise<EvalRun[]> {
    const rows = await this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.agentId, agentId))
      .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
      .limit(limit);
    return rows.map(toRun);
  }

  async latestByConfig(agentId: string, configHashes: string[]): Promise<Map<string, EvalRun>> {
    // 每个摘要一次走索引(agent_id, config_hash, created_at)取最新一条:版本数有限,不会多
    const found = await Promise.all(
      [...new Set(configHashes)].map(async (hash) => {
        const rows = await this.db
          .select()
          .from(evalRuns)
          .where(and(eq(evalRuns.agentId, agentId), eq(evalRuns.configHash, hash)))
          .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
          .limit(1);
        return rows[0] ? ([hash, toRun(rows[0])] as const) : null;
      }),
    );
    return new Map(found.filter((x) => x !== null));
  }

  async results(evalRunId: string): Promise<EvalResult[]> {
    const rows = await this.db
      .select()
      .from(evalResults)
      .where(eq(evalResults.evalRunId, evalRunId))
      .orderBy(asc(evalResults.caseName), asc(evalResults.caseId));
    return rows.map(toResult);
  }

  async gradeResult(
    evalRunId: string,
    caseId: string,
    g: {
      status: "passed" | "failed" | "error";
      failures: string[];
      output?: EvalOutput;
      costMicroUsd?: number;
      durationMs?: number;
    },
  ): Promise<void> {
    await this.db
      .update(evalResults)
      .set({
        status: g.status,
        failures: g.failures,
        output: g.output ?? null,
        costMicroUsd: g.costMicroUsd ?? null,
        durationMs: g.durationMs ?? null,
        gradedAt: new Date(),
      })
      .where(
        and(
          eq(evalResults.evalRunId, evalRunId),
          eq(evalResults.caseId, caseId),
          eq(evalResults.status, "pending"),
        ),
      );
  }

  async finishRun(id: string, counts: { passed: number; failed: number }): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ status: "done", passed: counts.passed, failed: counts.failed, finishedAt: new Date() })
      .where(and(eq(evalRuns.id, id), eq(evalRuns.status, "running")));
  }
}
