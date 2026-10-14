// 编排层:哪些运行接受追加消息;引擎中途抛出时,已受理的追加消息记为未送达并告诉界面。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { InMemorySteerChannel } from "@/lib/modules/run/adapters/in-memory-steer-channel";
import { RunOrchestrator, topicOf } from "@/lib/modules/run/application/orchestrator";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { SessionSource } from "@/lib/modules/session/ports";
import type { AgentEvent, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

async function setup(
  source: SessionSource,
  engine: EnginePort,
  channel = new InMemorySteerChannel(),
) {
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws", source });
  const bus = new InMemoryBus();
  const orch = new RunOrchestrator({
    sessions,
    agents,
    engine,
    bus,
    platformCredentials: { baseUrl: "x", key: "k" },
    steerChannel: channel,
  });
  return { orch, bus, channel };
}

class CtxEngine implements EnginePort {
  ctx?: RunContext;
  async run(_s: unknown, ctx: RunContext): Promise<RunResult> {
    this.ctx = ctx;
    return { status: "success", summary: "ok" };
  }
}

describe("编排 × 追加消息", () => {
  it("工作台与 API 会话的运行接受追加;接口调用与嵌入组件不接受", async () => {
    for (const [source, expected] of [
      ["web", true],
      ["api", true],
      ["invoke", false],
      ["embed", false],
    ] as const) {
      const engine = new CtxEngine();
      const { orch } = await setup(source, engine);
      await orch.execute(
        { sessionId: "s1", prompt: "hi", runId: "r1" },
        new AbortController().signal,
      );
      expect(Boolean(engine.ctx?.steer), source).toBe(expected);
    }
  });

  it("运行结束后不再受理(接口答 not_accepting)", async () => {
    const { orch, channel } = await setup("web", new CtxEngine());
    await orch.execute(
      { sessionId: "s1", prompt: "hi", runId: "r1" },
      new AbortController().signal,
    );
    expect(await channel.offer("r1", { id: "late", text: "x" })).toBe("rejected");
  });

  it("引擎中途抛出:已受理未交出的追加消息记为未送达,并发 dropped 事件", async () => {
    const channel = new InMemorySteerChannel();
    const boom: EnginePort = {
      async run(_s, ctx) {
        // 运行开始后用户追加了一条,引擎还没取就炸了
        await channel.offer("r1", { id: "m1", text: "补充" });
        expect(ctx.steer).toBeDefined();
        throw new Error("引擎炸了");
      },
    };
    const { orch, bus } = await setup("web", boom, channel);
    const events: AgentEvent[] = [];
    bus.subscribe(topicOf("s1", "r1"), (e) => events.push(e));
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, new AbortController().signal),
    ).rejects.toThrow(/引擎炸了/);
    expect(await channel.awaitOutcome("r1", "m1", 100)).toBe("dropped");
    expect(events).toContainEqual({ kind: "steer", id: "m1", text: "补充", outcome: "dropped" });
  });

  it("通道开不了:这一轮不接受追加,运行照常", async () => {
    const channel = new InMemorySteerChannel();
    channel.open = async () => {
      throw new Error("redis down");
    };
    const engine = new CtxEngine();
    const { orch } = await setup("web", engine, channel);
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, new AbortController().signal),
    ).resolves.toMatchObject({ status: "success" });
    expect(engine.ctx?.steer).toBeUndefined();
  });
});
