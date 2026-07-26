// 用例编排测试:全部端口用内存 fake,不碰真 IO、不调模型。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAssistantRepo } from "@/lib/modules/assistant/adapters/in-memory-assistant-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { RunOrchestrator, topicOf } from "@/lib/modules/run/application/orchestrator";
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
  const assistants = new InMemoryAssistantRepo([
    {
      id: "a1",
      name: "通用助手",
      config: { systemPrompt: "你是助手", model: "sonnet" },
    },
  ]);
  const bus = new InMemoryBus();
  await sessions.create({ id: "s1", assistantId: "a1", workspaceDir: "/ws/s1" });
  const orch = new RunOrchestrator({
    sessions,
    assistants,
    engine,
    bus,
    platformCredentials: PLATFORM,
  });
  return { sessions, assistants, bus, orch };
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

    expect(got.map((e) => e.kind)).toEqual(["status", "text", "tool_use", "result"]);
  });

  it("首尾补齐 status 与 result 事件", async () => {
    const { bus, orch } = await setup(new FakeEngine());
    const got: AgentEvent[] = [];
    bus.subscribe(topicOf("s1"), (e) => got.push(e));
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal);

    expect(got[0]).toMatchObject({ kind: "status", state: "running" });
    expect(got.at(-1)).toMatchObject({ kind: "result", status: "success" });
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

  it("请求级覆盖优先于平台默认", async () => {
    const engine = new FakeEngine();
    const { orch } = await setup(engine);
    await orch.execute(
      { sessionId: "s1", prompt: "hi", override: { key: "sk-caller", model: "haiku" } },
      signal,
    );
    expect(engine.lastCtx?.credentials).toEqual({ baseUrl: PLATFORM.baseUrl, key: "sk-caller" });
    expect(engine.lastSpec?.model).toEqual({ alias: "haiku" });
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
    expect(got.at(-1)).toMatchObject({ kind: "result", status: "failed", summary: "炸了" });
  });

  it("会话不存在时抛错", async () => {
    const { orch } = await setup(new FakeEngine());
    await expect(orch.execute({ sessionId: "nope", prompt: "hi" }, signal)).rejects.toThrow(
      /session not found/,
    );
  });

  it("事件总线故障不影响 agent 跑完", async () => {
    const engine = new FakeEngine([{ kind: "text", text: "x" }]);
    const { sessions, assistants } = await setup(engine);
    const broken = new RunOrchestrator({
      sessions,
      assistants,
      engine,
      bus: {
        publish: async () => {
          throw new Error("bus down");
        },
        subscribe: () => () => {},
      },
      platformCredentials: PLATFORM,
    });
    await expect(broken.execute({ sessionId: "s1", prompt: "hi" }, signal)).resolves.toMatchObject({
      status: "success",
    });
  });
});
