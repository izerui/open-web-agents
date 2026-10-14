// EvalRepo 的内存实现:单测用,语义与 MySQL 实现一致。

import type { EvalAssertions, EvalOutput } from "@/lib/modules/eval/domain/assertions";
import type { EvalCase, EvalRepo, EvalResult, EvalRun } from "@/lib/modules/eval/ports";

export class InMemoryEvalRepo implements EvalRepo {
  private readonly cases = new Map<string, EvalCase>();
  private readonly runs = new Map<string, EvalRun>();
  private readonly res = new Map<string, EvalResult[]>();
  private clock = 0;

  async listCases(agentId: string) {
    return [...this.cases.values()]
      .filter((c) => c.agentId === agentId)
      .map((c) => structuredClone(c));
  }
  async getCase(id: string) {
    const c = this.cases.get(id);
    return c ? structuredClone(c) : null;
  }
  async createCase(c: Omit<EvalCase, "createdAt" | "updatedAt">) {
    const now = ++this.clock;
    const saved = { ...structuredClone(c), createdAt: now, updatedAt: now };
    this.cases.set(c.id, saved);
    return structuredClone(saved);
  }
  async updateCase(
    id: string,
    patch: { name: string; input: unknown; assertions: EvalAssertions },
  ) {
    const c = this.cases.get(id);
    if (c) this.cases.set(id, { ...c, ...structuredClone(patch), updatedAt: ++this.clock });
  }
  async deleteCase(id: string) {
    this.cases.delete(id);
  }
  async createRun(run: Omit<EvalRun, "createdAt">, results: EvalResult[]) {
    this.runs.set(run.id, { ...structuredClone(run), createdAt: ++this.clock });
    this.res.set(run.id, structuredClone(results));
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async listRuns(agentId: string, limit: number) {
    return [...this.runs.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async results(evalRunId: string) {
    return structuredClone(this.res.get(evalRunId) ?? []);
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
  ) {
    const r = (this.res.get(evalRunId) ?? []).find((x) => x.caseId === caseId);
    if (r && r.status === "pending") Object.assign(r, g, { gradedAt: ++this.clock });
  }
  async finishRun(id: string, counts: { passed: number; failed: number }) {
    const r = this.runs.get(id);
    if (r && r.status === "running")
      Object.assign(r, counts, { status: "done", finishedAt: ++this.clock });
  }
}
