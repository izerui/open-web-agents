import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import {
  EnqueueTargetMissing,
  PromptTooLarge,
  RunEnqueuer,
} from "@/lib/modules/run/application/enqueue";
import { MAX_PROMPT_CHARS } from "@/lib/modules/run/domain/limits";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it } from "vitest";

async function setup(withCrypto = true) {
  const runs = new InMemoryRunRepo();
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "v1", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws" });
  const enqueuer = new RunEnqueuer({
    runs,
    sessions,
    agents,
    encryptOverride: withCrypto ? (o) => `enc:${JSON.stringify(o)}` : undefined,
  });
  return { runs, agents, enqueuer };
}

describe("RunEnqueuer", () => {
  it("入队时记下智能体配置快照", async () => {
    const { runs, enqueuer } = await setup();
    await enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "hi" });
    expect((await runs.getPayload("r1"))?.agentConfig).toEqual({
      systemPrompt: "v1",
      model: "sonnet",
    });
  });

  it("请求级覆盖加密后落库,明文不出现在载荷里", async () => {
    const { runs, enqueuer } = await setup();
    await enqueuer.enqueue({
      runId: "r1",
      sessionId: "s1",
      prompt: "hi",
      override: { key: "sk-secret" },
    });
    const p = await runs.getPayload("r1");
    expect(p?.overrideEnc).toBe(`enc:${JSON.stringify({ key: "sk-secret" })}`);
  });

  it("没有加密能力时拒绝带覆盖的请求,绝不明文落库", async () => {
    const { enqueuer } = await setup(false);
    await expect(
      enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "hi", override: { key: "k" } }),
    ).rejects.toThrow(/明文/);
  });

  it("空覆盖不落库", async () => {
    const { runs, enqueuer } = await setup(false);
    await enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "hi", override: {} });
    expect((await runs.getPayload("r1"))?.overrideEnc).toBeUndefined();
  });

  it("超长输入在入队前拒绝", async () => {
    const { runs, enqueuer } = await setup();
    await expect(
      enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }),
    ).rejects.toBeInstanceOf(PromptTooLarge);
    expect(await runs.get("r1")).toBeNull();
  });

  it("会话或智能体不存在时拒绝", async () => {
    const { enqueuer } = await setup();
    await expect(
      enqueuer.enqueue({ runId: "r1", sessionId: "nope", prompt: "hi" }),
    ).rejects.toBeInstanceOf(EnqueueTargetMissing);
  });
});
