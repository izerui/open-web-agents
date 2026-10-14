import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { InMemoryEvalRepo } from "@/lib/modules/eval/adapters/in-memory-eval-repo";
import { readEvalRun, startEvalRun } from "@/lib/modules/eval/application/eval-runner";
import type { EnqueueRequest } from "@/lib/modules/run/application/enqueue";
import type { RunRecord } from "@/lib/modules/run/domain/run-result";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it } from "vitest";

async function setup(opts: { inputSchema?: Record<string, unknown>; enqueueFails?: boolean } = {}) {
  const agents = new InMemoryAgentRepo([
    {
      id: "a1",
      ownerId: "u1",
      name: "审查",
      config: {
        systemPrompt: "p",
        model: "sonnet",
        ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
      },
    },
  ]);
  const evals = new InMemoryEvalRepo();
  const sessions = new InMemorySessionRepo();
  const enqueued: EnqueueRequest[] = [];
  const records = new Map<string, RunRecord>();
  let n = 0;
  const deps = {
    evals,
    agents,
    releases: new AgentReleases(agents, new InMemoryAgentVersionRepo(agents)),
    sessions,
    workspaceFor: async (id: string) => `/ws/${id}`,
    enqueue: async (r: EnqueueRequest) => {
      if (opts.enqueueFails) throw new Error("队列不可用");
      enqueued.push(r);
    },
    results: { getResult: async (id: string) => records.get(id) ?? null },
    newId: () => `id${++n}`,
  };
  const finish = (taskId: string, over: Partial<RunRecord>) =>
    records.set(taskId, {
      id: taskId,
      status: "success",
      structured: null,
      salvaged: false,
      finalText: "完成",
      cost: { usd: 0.01, input: 1, output: 1 },
      error: null,
      agentVersion: null,
      startedAt: new Date(0),
      endedAt: new Date(2_000),
      ...over,
    });
  return { deps, evals, sessions, enqueued, finish };
}

describe("startEvalRun", () => {
  it("没有用例:409,不建评测", async () => {
    const t = await setup();
    expect(
      await startEvalRun(t.deps, { agentId: "a1", target: "draft", userId: "u1" }),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("每个用例一个评测会话(无人值守、记在发起人名下)并入队,不投回调", async () => {
    const t = await setup();
    await t.evals.createCase({
      id: "c1",
      agentId: "a1",
      name: "正常合同",
      input: "审查这份合同",
      assertions: {},
    });
    await t.evals.createCase({
      id: "c2",
      agentId: "a1",
      name: "空输入",
      input: { x: 1 },
      assertions: {},
    });
    const r = await startEvalRun(t.deps, { agentId: "a1", target: "draft", userId: "u9" });
    expect(r.ok && r.run).toMatchObject({ status: "running", total: 2, startedBy: "u9" });
    expect(t.enqueued).toHaveLength(2);
    expect(t.enqueued.every((e) => e.noCallback === true)).toBe(true);
    expect(t.enqueued[1]?.prompt).toBe('{"x":1}');
    const s = await t.sessions.get(t.enqueued[0]?.sessionId ?? "");
    expect(s).toMatchObject({ source: "eval", unattended: true, billingUserId: "u9" });
    expect(s?.ownerId).toBeUndefined(); // 不进工作台会话列表
  });

  it("入参不符合 inputSchema 的用例不发起运行,直接判 error", async () => {
    const t = await setup({
      inputSchema: {
        type: "object",
        required: ["contract"],
        properties: { contract: { type: "string" } },
      },
    });
    await t.evals.createCase({
      id: "c1",
      agentId: "a1",
      name: "合规",
      input: { contract: "x" },
      assertions: {},
    });
    await t.evals.createCase({
      id: "c2",
      agentId: "a1",
      name: "缺字段",
      input: { other: 1 },
      assertions: {},
    });
    await t.evals.createCase({
      id: "c3",
      agentId: "a1",
      name: "纯文本",
      input: "x",
      assertions: {},
    });
    const r = await startEvalRun(t.deps, { agentId: "a1", target: "draft", userId: "u1" });
    expect(t.enqueued).toHaveLength(1);
    const res = await t.evals.results(r.ok ? r.run.id : "");
    expect(res.map((x) => [x.caseId, x.status])).toEqual([
      ["c1", "pending"],
      ["c2", "error"],
      ["c3", "error"],
    ]);
  });

  it("指定的版本不存在:404", async () => {
    const t = await setup();
    await t.evals.createCase({ id: "c1", agentId: "a1", name: "x", input: "x", assertions: {} });
    expect(await startEvalRun(t.deps, { agentId: "a1", target: 7, userId: "u1" })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("入队失败:那个用例判 error,评测照样建好", async () => {
    const t = await setup({ enqueueFails: true });
    await t.evals.createCase({ id: "c1", agentId: "a1", name: "x", input: "x", assertions: {} });
    const r = await startEvalRun(t.deps, { agentId: "a1", target: "draft", userId: "u1" });
    const res = await t.evals.results(r.ok ? r.run.id : "");
    expect(res[0]).toMatchObject({ status: "error" });
    expect(res[0]?.failures?.[0]).toMatch(/没能发起运行/);
  });
});

describe("readEvalRun", () => {
  it("运行结束才判分;全部判完收尾,error 计入失败;再读不会改动结论", async () => {
    const t = await setup({
      inputSchema: undefined,
    });
    await t.evals.createCase({
      id: "c1",
      agentId: "a1",
      name: "应当通过",
      input: "x",
      assertions: { contains: ["完成"], maxCostUsd: 0.05, maxDurationMs: 5_000 },
    });
    await t.evals.createCase({
      id: "c2",
      agentId: "a1",
      name: "应当失败",
      input: "y",
      assertions: {},
    });
    const started = await startEvalRun(t.deps, { agentId: "a1", target: "draft", userId: "u1" });
    const id = started.ok ? started.run.id : "";
    const [e1, e2] = t.enqueued;

    // 都还没结束:一个还没有运行记录,一个正在跑(有记录但不是终态)—— 都不判分
    t.finish(e2?.runId ?? "", { status: "running", finalText: null, endedAt: null });
    let r = await readEvalRun(t.deps, id);
    expect(r?.results.map((x) => x.status)).toEqual(["pending", "pending"]);
    expect(r?.run.status).toBe("running");

    t.finish(e1?.runId ?? "", {});
    r = await readEvalRun(t.deps, id);
    expect(r?.results.find((x) => x.caseId === "c1")).toMatchObject({
      status: "passed",
      costMicroUsd: 10_000,
      durationMs: 2_000,
    });
    expect(r?.run.status).toBe("running");

    t.finish(e2?.runId ?? "", { status: "failed", error: { kind: "x", message: "上游 503" } });
    r = await readEvalRun(t.deps, id);
    expect(r?.results.find((x) => x.caseId === "c2")?.failures?.[0]).toMatch(/上游 503/);
    expect(r?.run).toMatchObject({ status: "done", passed: 1, failed: 1 });

    // 判过的不再改:运行记录后来变了也一样
    t.finish(e2?.runId ?? "", { status: "success" });
    r = await readEvalRun(t.deps, id);
    expect(r?.results.find((x) => x.caseId === "c2")?.status).toBe("failed");
    expect(r?.run).toMatchObject({ passed: 1, failed: 1 });
  });
});
