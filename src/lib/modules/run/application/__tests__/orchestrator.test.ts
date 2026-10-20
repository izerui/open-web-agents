// 用例编排测试:全部端口用内存 fake,不碰真 IO、不调模型。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { platformModels } from "@/lib/modules/model-gateway/application/__tests__/platform-models";
import {
  EngineRunFailed,
  RunOrchestrator,
  topicOf,
} from "@/lib/modules/run/application/orchestrator";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { beforeEach, describe, expect, it } from "vitest";

/** 记录调用参数的假引擎,可编排要吐的事件与结果。 */
class FakeEngine implements EnginePort {
  lastSpec?: AgentSpec;
  lastCtx?: RunContext;
  constructor(
    private readonly events: AgentEvent[] = [],
    private readonly result: RunResult = { status: "success", summary: "ok", sessionId: "sdk_1" },
  ) {}

  async run(
    spec: AgentSpec,
    ctx: RunContext,
    onEvent: (e: AgentEvent) => void,
    _signal: AbortSignal,
  ): Promise<RunResult> {
    this.lastSpec = spec;
    this.lastCtx = ctx;
    for (const e of this.events) onEvent(e);
    return this.result;
  }
}

const PLATFORM = { baseUrl: "https://platform-gw", key: "sk-platform" };

async function setup(engine: EnginePort) {
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    {
      id: "a1",
      ownerId: "u1",
      name: "通用智能体",
      config: { systemPrompt: "你是智能体", model: "sonnet" },
    },
  ]);
  const bus = new InMemoryBus();
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1" });
  const orch = new RunOrchestrator({
    sessions,
    agents,
    engine,
    bus,
    resolveModels: platformModels(PLATFORM),
  });
  return { sessions, agents, bus, orch };
}

describe("RunOrchestrator.execute", () => {
  let signal: AbortSignal;
  beforeEach(() => {
    signal = new AbortController().signal;
  });

  it("把 agent 事件实时发布到会话 topic", async () => {
    const engine = new FakeEngine([
      { kind: "text", text: "你好" },
      { kind: "tool_use", tool: "Bash", input: { command: "ls" } },
    ]);
    const { bus, orch } = await setup(engine);

    const got: AgentEvent[] = [];
    bus.subscribe(topicOf("s1"), (e) => got.push(e));
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);

    expect(got.map((e) => e.kind)).toEqual(["status", "text", "tool_use"]);
  });

  it("开头补 running 状态;终态事件不由编排层发布(worker 落库后才发)", async () => {
    const { bus, orch } = await setup(new FakeEngine());
    const got: AgentEvent[] = [];
    bus.subscribe(topicOf("s1"), (e) => got.push(e));
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);

    expect(got[0]).toMatchObject({ kind: "status", state: "running" });
    expect(got.some((e) => e.kind === "result")).toBe(false);
  });

  it("相邻的文本增量合并成一条再发布,顺序不变", async () => {
    const engine = new FakeEngine([
      { kind: "text", text: "你" },
      { kind: "text", text: "好" },
      { kind: "tool_use", tool: "Bash", input: {} },
      { kind: "text", text: "完" },
      { kind: "text", text: "成" },
    ]);
    const { bus, orch } = await setup(engine);
    const got: AgentEvent[] = [];
    bus.subscribe(topicOf("s1"), (e) => got.push(e));
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);

    expect(got.slice(1)).toEqual([
      { kind: "text", text: "你好" },
      { kind: "tool_use", tool: "Bash", input: {} },
      { kind: "text", text: "完成" },
    ]);
  });

  it("按入队时的配置快照执行", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute(
      {
        sessionId: "s1",
        prompt: "hi",
        agentConfig: { systemPrompt: "快照里的提示词", model: "haiku" },
      },
      signal,
    );
    expect(engine.lastSpec?.systemPrompt).toContain("快照里的提示词");
    expect(engine.lastSpec?.model).toEqual({ ref: "haiku", modelId: "model-haiku" });
  });

  it("启动前已被中止:不调用引擎", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    const ac = new AbortController();
    ac.abort();
    const r = await orch.execute({ sessionId: "s1", prompt: "hi" }, ac.signal);
    expect(r.status).toBe("failed");
    expect(engine.lastCtx).toBeUndefined();
  });

  it("把工作目录与 prompt 传给引擎", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute({ sessionId: "s1", prompt: "做个视频" }, signal);

    expect(engine.lastCtx?.workspaceDir).toBe("/ws/s1");
    expect(engine.lastCtx?.prompt).toBe("做个视频");
  });

  it("没有会话级/请求级覆盖时用平台默认凭证", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(engine.lastCtx?.credentials).toEqual(PLATFORM);
  });

  it("请求可选择平台模型,历史用户凭证覆盖不再生效", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute(
      {
        sessionId: "s1",
        prompt: "hi",
        override: JSON.parse('{"key":"sk-caller","baseUrl":"https://attacker","model":"haiku"}'),
      },
      signal,
    );
    expect(engine.lastCtx?.credentials).toEqual(PLATFORM);
    expect(engine.lastSpec?.model).toEqual({ ref: "haiku", modelId: "model-haiku" });
  });

  it("AI 编辑强制平台凭证和设计模型,计费归发起账号", async () => {
    const engine = new FakeEngine();
    const { orch, sessions } = await setup(engine);
    await sessions.create({
      id: "design",
      agentId: "a1",
      workspaceDir: "/ws/design",
      source: "design",
      ownerId: "author",
      billingUserId: "author",
    });
    await orch.execute(
      {
        sessionId: "design",
        prompt: "edit",
        override: JSON.parse('{"key":"legacy-key","baseUrl":"https://elsewhere","model":"haiku"}'),
      },
      signal,
    );
    expect(engine.lastCtx?.designMode).toBe(true);
    expect(engine.lastCtx?.credentials).toEqual(PLATFORM);
    expect(engine.lastSpec?.model).toEqual({ ref: "sonnet", modelId: "model-sonnet" });
    expect((await sessions.get("design"))?.billingUserId).toBe("author");
  });

  it("记下 sdkSessionId,下一轮带上 resume", async () => {
    const engine = new FakeEngine();
    const { sessions, orch } = await setup(engine);

    await orch.execute({ sessionId: "s1", prompt: "第一轮" }, signal);
    expect((await sessions.get("s1"))?.sdkSessionId).toBe("sdk_1");

    await orch.execute({ sessionId: "s1", prompt: "第二轮" }, signal);
    expect(engine.lastCtx?.resumeSessionId).toBe("sdk_1");
  });

  it("首轮不带 resume", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(engine.lastCtx?.resumeSessionId).toBeUndefined();
  });

  it("失败结果也发 result 事件,并带上错误信息", async () => {
    const engine = new FakeEngine([], {
      status: "failed",
      error: { kind: "engine_error", message: "炸了" },
    });
    const { bus, orch } = await setup(engine);
    const got: AgentEvent[] = [];
    bus.subscribe(topicOf("s1"), (e) => got.push(e));

    const r = await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(r.status).toBe("failed");
    expect(r.error?.message).toBe("炸了");
    expect(got.some((e) => e.kind === "result")).toBe(false);
  });

  it("会话不存在时抛错", async () => {
    const { orch } = await setup(new FakeEngine());
    await expect(orch.execute({ sessionId: "nope", prompt: "hi" }, signal)).rejects.toThrow(
      /session not found/,
    );
  });

  it("事件总线故障不影响 agent 跑完", async () => {
    const engine = new FakeEngine([{ kind: "text", text: "x" }]);
    const { sessions, agents } = await setup(engine);
    const broken = new RunOrchestrator({
      sessions,
      agents,
      engine,
      bus: {
        publish: async () => {
          throw new Error("bus down");
        },
        subscribe: () => () => {},
      },
      resolveModels: platformModels(PLATFORM),
    });
    await expect(broken.execute({ sessionId: "s1", prompt: "hi" }, signal)).resolves.toMatchObject({
      status: "success",
    });
  });
});

describe("outputSchema 契约守门", () => {
  const signal = new AbortController().signal;
  const schema = {
    type: "object",
    properties: { videoId: { type: "string" } },
    required: ["videoId"],
  };

  async function setupWithSchema(result: RunResult) {
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      {
        id: "a1",
        ownerId: "u1",
        name: "专用智能体",
        config: { systemPrompt: "p", model: "sonnet", outputSchema: schema },
      },
    ]);
    const bus = new InMemoryBus();
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1" });
    const orch = new RunOrchestrator({
      sessions,
      agents,
      engine: new FakeEngine([], result),
      bus,
      resolveModels: platformModels(PLATFORM),
    });
    return { orch, bus };
  }

  it("结果符合 schema → 成功", async () => {
    const { orch } = await setupWithSchema({
      status: "success",
      structured: { videoId: "v1" },
    });
    expect((await orch.execute({ sessionId: "s1", prompt: "hi" }, signal)).status).toBe("success");
  });

  it("结果缺必填字段 → 判失败,不让调用方拿到半对结果", async () => {
    const { orch } = await setupWithSchema({ status: "success", structured: { wrong: 1 } });
    const r = await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("schema_mismatch");
    expect(r.error?.message).toMatch(/videoId/);
  });

  it("契约失败时清掉不合格的 structured,原因写进 error 供终态事件展示", async () => {
    const { orch } = await setupWithSchema({ status: "success", structured: {} });
    const r = await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(r).toMatchObject({ status: "failed", error: { kind: "schema_mismatch" } });
    expect(r.structured).toBeUndefined();
  });
});

describe("计费账号", () => {
  const signal = new AbortController().signal;

  async function setupBilling() {
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
    ]);
    // API Key 建的会话:没有人用归属,计费归签发人 u2
    await sessions.create({
      id: "s1",
      agentId: "a1",
      workspaceDir: "/ws/s1",
      callerApiKeyId: "key-1",
      billingUserId: "u2",
    });
    const engine = new FakeEngine();
    const orch = new RunOrchestrator({
      sessions,
      agents,
      engine,
      bus: new InMemoryBus(),
      resolveModels: platformModels(PLATFORM),
    });
    return { orch, engine };
  }

  it("API Key 会话也使用平台凭证,计费仍归签发人", async () => {
    const { orch, engine } = await setupBilling();
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);
    expect(engine.lastCtx?.credentials).toEqual(PLATFORM);
  });
});

describe("运行中计费", () => {
  const usage = (messageId: string, input: number, output: number): AgentEvent => ({
    kind: "usage",
    messageId,
    input,
    output,
  });

  async function setupCharging(
    events: AgentEvent[],
    verdict: (total: { input: number; output: number }) => "continue" | "stop",
  ) {
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
    ]);
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1", ownerId: "u1" });
    let engineSignal: AbortSignal | undefined;
    const engine: EnginePort = {
      async run(_spec, _ctx, onEvent, sig) {
        engineSignal = sig;
        for (const e of events) onEvent(e);
        await new Promise((r) => setTimeout(r, 0));
        return { status: "success", summary: "ok", structured: { a: 1 } };
      },
    };
    const seen: { input: number; output: number }[] = [];
    const orch = new RunOrchestrator({
      sessions,
      agents,
      engine,
      bus: new InMemoryBus(),
      resolveModels: platformModels(PLATFORM),
      chargeProgress: async (_runId, t) => {
        seen.push({ input: t.input, output: t.output });
        return verdict(t);
      },
    });
    return { orch, seen, engineSignal: () => engineSignal };
  }

  it("同一条消息多次到达按最后一次计,不重复累加", async () => {
    const { orch, seen } = await setupCharging(
      [usage("m1", 100, 5), usage("m1", 100, 50), usage("m2", 200, 10)],
      () => "continue",
    );
    const r = await orch.execute(
      { sessionId: "s1", prompt: "hi", runId: "r1" },
      new AbortController().signal,
    );
    expect(r.status).toBe("success");
    expect(seen.at(-1)).toEqual({ input: 300, output: 60 });
  });

  it("积分不够继续:中止引擎,运行失败 insufficient_credits,不带结构化结果", async () => {
    const { orch, engineSignal } = await setupCharging(
      [usage("m1", 1000, 0), usage("m2", 5000, 0)],
      (t) => (t.input > 2000 ? "stop" : "continue"),
    );
    const r = await orch.execute(
      { sessionId: "s1", prompt: "hi", runId: "r1" },
      new AbortController().signal,
    );
    expect(engineSignal()?.aborted).toBe(true);
    expect(r).toMatchObject({ status: "failed", error: { kind: "insufficient_credits" } });
    expect(r.structured).toBeUndefined();
  });

  it("计费检查本身出错不拖垮运行", async () => {
    const sessions = await setupCharging([usage("m1", 1, 1)], () => {
      throw new Error("db down");
    });
    const r = await sessions.orch.execute(
      { sessionId: "s1", prompt: "hi", runId: "r1" },
      new AbortController().signal,
    );
    expect(r.status).toBe("success");
  });
});

describe("费用恢复记录", () => {
  it("引擎一交回费用就保存(带锁定价目引用),早于运行中计费检查等待的收尾", async () => {
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
    ]);
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1", ownerId: "u1" });
    const saved: { runId: string; cost: unknown }[] = [];
    const engine: EnginePort = {
      async run(_s, _c, onEvent) {
        onEvent({ kind: "usage", messageId: "m1", input: 10, output: 1 });
        return { status: "success", summary: "ok", cost: { input: 10, output: 1 } };
      },
    };
    const orch = new RunOrchestrator({
      sessions,
      agents,
      engine,
      bus: new InMemoryBus(),
      resolveModels: platformModels(PLATFORM),
      // 运行中计费检查一直不返回(数据库卡住)
      chargeProgress: () => new Promise(() => {}),
      saveCostRecovery: async (runId, cost) => {
        saved.push({ runId, cost });
      },
    });
    void orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, new AbortController().signal);
    for (let i = 0; i < 100 && saved.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      runId: "r1",
      cost: { input: 10, output: 1, pricing: { providerId: "platform-default" } },
    });
  });

  it("引擎交回费用之后收尾出错:抛 EngineRunFailed,带着已交回的费用", async () => {
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
    ]);
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1", ownerId: "u1" });
    const orch = new RunOrchestrator({
      sessions,
      agents,
      engine: new FakeEngine([], {
        status: "success",
        summary: "ok",
        sessionId: "sdk_1",
        cost: { input: 10, output: 1 },
      }),
      bus: new InMemoryBus(),
      resolveModels: platformModels(PLATFORM),
      // 收尾时同步抛出(绕过了它后面的 .catch)
      recordRunSession: () => {
        throw new Error("boom");
      },
    });
    const err = await orch
      .execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineRunFailed);
    expect((err as EngineRunFailed).cost).toMatchObject({
      input: 10,
      output: 1,
      pricing: { providerId: "platform-default" },
    });
  });

  it("引擎启动前出错:不是 EngineRunFailed(确认没有调用模型)", async () => {
    const orch = new RunOrchestrator({
      sessions: new InMemorySessionRepo(),
      agents: new InMemoryAgentRepo([]),
      engine: new FakeEngine(),
      bus: new InMemoryBus(),
      resolveModels: platformModels(PLATFORM),
    });
    const err = await orch
      .execute({ sessionId: "missing", prompt: "hi", runId: "r1" }, new AbortController().signal)
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(EngineRunFailed);
  });
});
