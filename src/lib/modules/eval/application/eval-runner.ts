// 发起与读取一次评测。
//
// 【发起】每个用例开一个评测会话(无人值守、不推回调、不进工作台会话列表),按选定的版本
// 入队 —— 与接口调用走同一个运行内核。入参不符合 inputSchema 的用例不发起运行,直接判 error,
// 不白花钱。先把"评测 + 各用例的待判结果"在一个事务里落库,再入队;某个用例入队失败就判 error。
// 【读取】读的时候判分:已经结束的运行,取它的统一结果按断言判一次并落库;全部判完就收尾。
// 不需要后台进程 —— 没人看的评测不必急着判。

import type { AgentReleases } from "@/lib/modules/agent/application/releases";
import { VersionNotFound } from "@/lib/modules/agent/application/releases";
import { contentHash } from "@/lib/modules/agent/domain/release";
import { validateInput } from "@/lib/modules/agent/domain/validate-output";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import type { EnqueueRequest } from "@/lib/modules/run/application/enqueue";
import { checkPromptSize } from "@/lib/modules/run/domain/limits";
import { type RunRecord, toRunResult } from "@/lib/modules/run/domain/run-result";
import type { SessionRepo } from "@/lib/modules/session/ports";
import { gradeRun, snapshotOutput } from "../domain/assertions";
import { casesHash } from "../domain/release-gate";
import type { EvalRepo, EvalResult, EvalRun } from "../ports";

export const MAX_EVAL_CASES = 100;

export interface EvalDeps {
  evals: EvalRepo;
  agents: Pick<AgentRepo, "get">;
  releases: Pick<AgentReleases, "at">;
  sessions: Pick<SessionRepo, "create">;
  /** 建好该会话的工作目录,返回绝对路径 */
  workspaceFor(sessionId: string): Promise<string>;
  enqueue(req: EnqueueRequest): Promise<unknown>;
  results: { getResult(taskId: string): Promise<RunRecord | null> };
  newId(): string;
}

export type StartResult =
  | { ok: true; run: EvalRun }
  | { ok: false; status: 404 | 409; reason: string };

export async function startEvalRun(
  deps: EvalDeps,
  req: { agentId: string; target: "draft" | number; userId: string },
): Promise<StartResult> {
  const agent = await deps.agents.get(req.agentId);
  if (!agent) return { ok: false, status: 404, reason: "agent not found" };
  const cases = await deps.evals.listCases(req.agentId);
  if (cases.length === 0) return { ok: false, status: 409, reason: "还没有评测用例" };

  let release: Awaited<ReturnType<AgentReleases["at"]>>;
  try {
    release = await deps.releases.at(agent, req.target === "draft" ? undefined : req.target);
  } catch (err) {
    if (err instanceof VersionNotFound) return { ok: false, status: 404, reason: err.message };
    throw err;
  }
  // 开跑时就把这一版的完整配置固定下来:入参校验与每个用例的运行都用这一份。
  // 曾经入队时每个用例各自再读一次当前草稿 —— 评测过程中保存草稿,前后用例跑的就不是同一份
  const fixed = { config: release.config, version: release.version };
  const configHash = contentHash({
    name: release.name,
    icon: release.icon,
    description: release.description,
    config: release.config,
  });
  const schema = fixed.config.inputSchema;

  const evalRunId = deps.newId();
  const planned: { result: EvalResult; enqueue?: EnqueueRequest }[] = [];
  for (const c of cases) {
    const base: EvalResult = {
      evalRunId,
      caseId: c.id,
      caseName: c.name,
      input: c.input,
      assertions: c.assertions,
      status: "pending",
    };
    // 入参与契约:与 invoke 同一条规则 —— 不符合的用例不发起运行
    const invalid =
      schema && typeof c.input === "string"
        ? "该版本声明了 inputSchema,用例输入须为符合它的对象"
        : schema && !validateInput(schema, c.input).ok
          ? "用例输入不符合该版本的 inputSchema"
          : undefined;
    const prompt = typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {});
    const size = checkPromptSize(prompt);
    const reason = invalid ?? (size.ok ? undefined : size.reason);
    if (reason) {
      planned.push({ result: { ...base, status: "error", failures: [reason] } });
      continue;
    }
    const sessionId = deps.newId();
    const taskId = deps.newId();
    await deps.sessions.create({
      id: sessionId,
      agentId: agent.id,
      workspaceDir: await deps.workspaceFor(sessionId),
      title: `评测:${c.name}`,
      unattended: true,
      source: "eval",
      billingUserId: req.userId,
      agentVersion: release.version ?? undefined,
    });
    planned.push({
      result: { ...base, taskId, sessionId },
      enqueue: { runId: taskId, sessionId, prompt, noCallback: true, release: fixed },
    });
  }

  const run: Omit<EvalRun, "createdAt"> = {
    id: evalRunId,
    agentId: agent.id,
    ...(release.version !== null ? { agentVersion: release.version } : {}),
    configHash,
    // 用例在开跑时就已读定(上面的 cases):之后改了用例,这次结果就对不上当前用例了
    casesHash: casesHash(cases) ?? undefined,
    status: "running",
    total: cases.length,
    passed: 0,
    failed: 0,
    startedBy: req.userId,
  };
  await deps.evals.createRun(
    run,
    planned.map((p) => p.result),
  );
  for (const p of planned) {
    if (!p.enqueue) continue;
    try {
      await deps.enqueue(p.enqueue);
    } catch (err) {
      await deps.evals.gradeResult(evalRunId, p.result.caseId, {
        status: "error",
        failures: [`没能发起运行:${err instanceof Error ? err.message : String(err)}`],
      });
    }
  }
  const saved = await deps.evals.getRun(evalRunId);
  if (!saved) throw new Error(`eval run vanished: ${evalRunId}`);
  return { ok: true, run: saved };
}

const TERMINAL = new Set(["success", "failed", "cancelled"]);

/** 读一次评测:顺带给已结束的运行判分,全部判完就收尾。 */
export async function readEvalRun(
  deps: Pick<EvalDeps, "evals" | "results">,
  evalRunId: string,
): Promise<{ run: EvalRun; results: EvalResult[] } | null> {
  const run = await deps.evals.getRun(evalRunId);
  if (!run) return null;
  let results = await deps.evals.results(evalRunId);

  let graded = false;
  for (const r of results) {
    if (r.status !== "pending" || !r.taskId) continue;
    const rec = await deps.results.getResult(r.taskId);
    if (!rec || !TERMINAL.has(rec.status)) continue;
    const out = toRunResult(rec);
    const durationMs =
      rec.startedAt && rec.endedAt ? rec.endedAt.getTime() - rec.startedAt.getTime() : null;
    const seen = {
      status: out.status,
      structured: out.structured,
      text: out.text,
      error: out.error,
      cost: out.cost,
      durationMs,
    };
    const g = gradeRun(r.assertions, seen);
    await deps.evals.gradeResult(evalRunId, r.caseId, {
      status: g.passed ? "passed" : "failed",
      failures: g.failures,
      output: snapshotOutput(seen),
      ...(out.cost?.usd !== undefined ? { costMicroUsd: Math.round(out.cost.usd * 1e6) } : {}),
      ...(durationMs !== null ? { durationMs } : {}),
    });
    graded = true;
  }
  if (graded) results = await deps.evals.results(evalRunId);

  if (run.status === "running" && results.every((r) => r.status !== "pending")) {
    const passed = results.filter((r) => r.status === "passed").length;
    await deps.evals.finishRun(evalRunId, { passed, failed: results.length - passed });
    const done = await deps.evals.getRun(evalRunId);
    return { run: done ?? run, results };
  }
  return { run, results };
}
