import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import {
  EnqueueTargetMissing,
  PromptTooLarge,
  RunEnqueuer,
} from "@/lib/modules/run/application/enqueue";
import { MAX_PROMPT_CHARS } from "@/lib/modules/run/domain/limits";
import type { NewRun } from "@/lib/modules/run/ports";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it } from "vitest";

async function setup(withCrypto = true) {
  const runs = new InMemoryRunRepo();
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "v1", model: "sonnet" } },
  ]);
  const versions = new InMemoryAgentVersionRepo(agents);
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws" });
  const enqueuer = new RunEnqueuer({
    runs,
    sessions,
    agents,
    releases: new AgentReleases(agents, versions),
    encryptOverride: withCrypto ? (o) => `enc:${JSON.stringify(o)}` : undefined,
  });
  return { runs, agents, versions, sessions, enqueuer };
}

describe("RunEnqueuer", () => {
  it("会话锁定了版本:草稿之后再改,运行仍按那一版的快照执行并记下版本号", async () => {
    const { runs, agents, versions, sessions, enqueuer } = await setup();
    const releases = new AgentReleases(agents, versions);
    const a1 = await agents.get("a1");
    if (!a1) throw new Error("seed missing");
    await releases.publish(a1, "u1");
    await agents.upsert({ ...a1, config: { systemPrompt: "v2-draft", model: "sonnet" } });
    await sessions.create({ id: "pinned", agentId: "a1", workspaceDir: "/w", agentVersion: 1 });

    await enqueuer.enqueue({ runId: "r-pinned", sessionId: "pinned", prompt: "hi" });
    const p = await runs.getPayload("r-pinned");
    expect(p?.agentConfig).toEqual({ systemPrompt: "v1", model: "sonnet" });
    expect(p?.agentVersion).toBe(1);

    // 跟随草稿的会话(s1)跑的是草稿,版本号为空
    await enqueuer.enqueue({ runId: "r-draft", sessionId: "s1", prompt: "hi" });
    const d = await runs.getPayload("r-draft");
    expect(d?.agentConfig).toEqual({ systemPrompt: "v2-draft", model: "sonnet" });
    expect(d?.agentVersion).toBeUndefined();
  });

  it("开了计费、会话没有可记账的账号(历史无归属会话):拒绝受理,不免费运行", async () => {
    const { runs, sessions, agents, versions } = await setup();
    const charged = { calls: 0 };
    const enqueuer = new RunEnqueuer({
      runs,
      sessions,
      agents,
      releases: new AgentReleases(agents, versions),
      charged: async () => {
        charged.calls++;
        throw new Error("不该走到计费事务");
      },
    });
    await expect(
      enqueuer.enqueue({ runId: "r-free", sessionId: "s1", prompt: "hi" }),
    ).rejects.toMatchObject({ code: "billing_account_missing" });
    expect(await runs.getPayload("r-free")).toBeNull();
    expect(charged.calls).toBe(0);

    // 有计费账号的会话照常走计费事务
    await sessions.create({ id: "owned", agentId: "a1", workspaceDir: "/w", ownerId: "u1" });
    await expect(
      enqueuer.enqueue({ runId: "r-owned", sessionId: "owned", prompt: "hi" }),
    ).rejects.toThrow("不该走到计费事务");
    expect(charged.calls).toBe(1);
  });

  it("会话锁定的版本不存在:按目标缺失拒绝,而不是悄悄改跑草稿", async () => {
    const { sessions, enqueuer } = await setup();
    await sessions.create({ id: "ghost", agentId: "a1", workspaceDir: "/w", agentVersion: 9 });
    await expect(
      enqueuer.enqueue({ runId: "r", sessionId: "ghost", prompt: "hi" }),
    ).rejects.toBeInstanceOf(EnqueueTargetMissing);
  });

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
      override: { model: "haiku" },
    });
    const p = await runs.getPayload("r1");
    expect(p?.overrideEnc).toBe(`enc:${JSON.stringify({ model: "haiku" })}`);
  });

  describe("回调目标快照", () => {
    async function capture(webhookUrl?: string) {
      const ctx = await setup();
      if (webhookUrl) {
        const a = await ctx.agents.get("a1");
        if (a) await ctx.agents.upsert({ ...a, webhookUrl });
      }
      const created: NewRun[] = [];
      const create = ctx.runs.create.bind(ctx.runs);
      ctx.runs.create = async (r) => {
        created.push(r);
        return create(r);
      };
      return { ...ctx, created };
    }

    it("没指定 callbackUrl:快照智能体此刻的默认地址,来源记为 agent", async () => {
      const { enqueuer, agents, created } = await capture("https://owner.example.com/a");
      await enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "hi" });
      // 受理之后再改,不影响已定下的快照
      const a = await agents.get("a1");
      if (a) await agents.upsert({ ...a, webhookUrl: "https://owner.example.com/b" });
      expect(created[0]?.callback).toEqual({ source: "agent", url: "https://owner.example.com/a" });
    });

    it("指定了 callbackUrl:来源记为 caller", async () => {
      const { enqueuer, created } = await capture("https://owner.example.com/a");
      await enqueuer.enqueue({
        runId: "r1",
        sessionId: "s1",
        prompt: "hi",
        callbackUrl: "https://caller.example.com/cb",
      });
      expect(created[0]?.callback).toEqual({
        source: "caller",
        url: "https://caller.example.com/cb",
      });
    });

    it("受理时智能体没配回调:记为 none(与没有快照的旧任务区分开)", async () => {
      const { enqueuer, created } = await capture();
      await enqueuer.enqueue({ runId: "r1", sessionId: "s1", prompt: "hi" });
      expect(created[0]?.callback).toEqual({ source: "none" });
    });
  });

  it("没有加密能力时拒绝带覆盖的请求,绝不明文落库", async () => {
    const { enqueuer } = await setup(false);
    await expect(
      enqueuer.enqueue({
        runId: "r1",
        sessionId: "s1",
        prompt: "hi",
        override: { model: "haiku" },
      }),
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
