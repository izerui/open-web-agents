import type { EvalAssertions } from "./domain/assertions";

export interface EvalCase {
  id: string;
  agentId: string;
  name: string;
  /** 字符串 = 文本输入;对象 = 按 inputSchema 的结构化输入 */
  input: unknown;
  assertions: EvalAssertions;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

export type EvalResultStatus = "pending" | "passed" | "failed" | "error";

export interface EvalResult {
  evalRunId: string;
  caseId: string;
  caseName: string;
  input: unknown;
  assertions: EvalAssertions;
  taskId?: string;
  sessionId?: string;
  status: EvalResultStatus;
  failures?: string[];
  costMicroUsd?: number;
  durationMs?: number;
  gradedAt?: number;
}

export interface EvalRun {
  id: string;
  agentId: string;
  /** undefined = 草稿 */
  agentVersion?: number;
  status: "running" | "done";
  total: number;
  passed: number;
  failed: number;
  startedBy: string;
  createdAt: number;
  finishedAt?: number;
}

export interface EvalRepo {
  listCases(agentId: string): Promise<EvalCase[]>;
  getCase(id: string): Promise<EvalCase | null>;
  createCase(c: Omit<EvalCase, "createdAt" | "updatedAt">): Promise<EvalCase>;
  updateCase(
    id: string,
    patch: { name: string; input: unknown; assertions: EvalAssertions },
  ): Promise<void>;
  deleteCase(id: string): Promise<void>;

  /** 建一次评测连同各用例的待判结果(同一事务:不会出现只建了一半的评测) */
  createRun(run: Omit<EvalRun, "createdAt">, results: EvalResult[]): Promise<void>;
  getRun(id: string): Promise<EvalRun | null>;
  listRuns(agentId: string, limit: number): Promise<EvalRun[]>;
  results(evalRunId: string): Promise<EvalResult[]>;
  /** 写回一个用例的判分(只改还是 pending 的;重复判分不会改动已有结论) */
  gradeResult(
    evalRunId: string,
    caseId: string,
    g: {
      status: "passed" | "failed" | "error";
      failures: string[];
      costMicroUsd?: number;
      durationMs?: number;
    },
  ): Promise<void>;
  /** 全部判完时收尾:写入通过 / 失败数与结束时刻(只改还在 running 的) */
  finishRun(id: string, counts: { passed: number; failed: number }): Promise<void>;
}
