// 故障注入:把每个可选依赖依次打挂,验证运行【降级而非崩溃】。
//
// 之前所有验证都在"依赖都正常"的前提下做的。但代码里写了不少降级路径 ——
// 事件发不出去、知识检索挂了、凭证解不开、回调打不通、审计写入失败……
// 这些分支从没被真正触发过,而它们恰恰是生产环境最先遇到的。
//
// 判断标准统一:【任何辅助能力的故障,都不该让用户的这一轮运行失败】。
// 结果已经算出来了,不能因为"记审计日志失败"就把它丢掉。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAssistantRepo } from "@/lib/modules/assistant/adapters/in-memory-assistant-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { type OrchestratorDeps, RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

class OkEngine implements EnginePort {
  lastCtx?: RunContext;
  lastSpec?: AgentSpec;
  async run(
    spec: AgentSpec,
    ctx: RunContext,
    _onEvent: (e: AgentEvent) => void,
    _signal: AbortSignal,
  ): Promise<RunResult> {
    this.lastCtx = ctx;
    this.lastSpec = spec;
    return { status: "success", summary: "ok", sessionId: "sdk-1" };
  }
}

const boom = () => Promise.reject(new Error("依赖挂了"));

async function setup(over: Partial<OrchestratorDeps> = {}, engine = new OkEngine()) {
  const sessions = new InMemorySessionRepo();
  const assistants = new InMemoryAssistantRepo([
    { id: "a1", ownerId: "u1", name: "助手", config: { systemPrompt: "p", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", assistantId: "a1", workspaceDir: "/ws", ownerId: "u1" });

  const orch = new RunOrchestrator({
    sessions,
    assistants,
    engine,
    bus: new InMemoryBus(),
    platformCredentials: { baseUrl: "platform", key: "pk" },
    ...over,
  });
  return { orch, sessions, engine };
}

const signal = () => new AbortController().signal;

describe("故障注入 / 事件总线", () => {
  it("总线完全挂掉,运行照样跑完 —— 用户拿得到结果,只是看不到过程", async () => {
    const { orch } = await setup({
      bus: { publish: boom, subscribe: () => () => {} },
    });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });

  it("总线间歇性失败也不中断", async () => {
    let n = 0;
    const flaky = {
      publish: async () => {
        if (n++ % 2 === 0) throw new Error("偶发失败");
      },
      subscribe: () => () => {},
    };
    const { orch } = await setup({ bus: flaky });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });
});

describe("故障注入 / 知识检索", () => {
  it("检索挂了就当没有知识库,不牵连整轮运行", async () => {
    const { orch, engine } = await setup({ retrieveKnowledge: boom });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
    // 提示词退回助手原始配置,没有被半截的检索结果污染
    expect(engine.lastSpec?.systemPrompt).toBe("p");
  });

  it("检索超时(挂很久)不该拖死运行 —— 由实现方自行兜底,这里验证异常路径", async () => {
    const { orch } = await setup({
      retrieveKnowledge: async () => {
        throw new Error("timeout");
      },
    });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });
});

describe("故障注入 / 用户凭证", () => {
  it("解密失败时回落平台默认凭证,而不是硬失败", async () => {
    const { orch, engine } = await setup({ userCredentials: boom });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
    expect(engine.lastCtx?.credentials).toEqual({ baseUrl: "platform", key: "pk" });
  });

  it("用户没配凭证(返回空)也回落平台默认", async () => {
    const { orch, engine } = await setup({ userCredentials: async () => ({}) });
    await orch.execute({ sessionId: "s1", prompt: "hi" }, signal());
    expect(engine.lastCtx?.credentials).toEqual({ baseUrl: "platform", key: "pk" });
  });
});

describe("故障注入 / 审计与回调", () => {
  it("记起跑锚点失败不影响运行 —— 审计是辅助,不能反过来杀主流程", async () => {
    const { orch } = await setup({ recordRunAnchor: boom });
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, signal()),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("记 SDK 会话失败不影响运行", async () => {
    const { orch } = await setup({ recordRunSession: boom });
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, signal()),
    ).resolves.toMatchObject({ status: "success" });
  });

  it("终态回调(webhook)抛异常不改变运行结果", async () => {
    const { orch } = await setup({
      onComplete: () => {
        throw new Error("webhook 崩了");
      },
    });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });

  it("重放缓冲抛异常时运行仍继续", async () => {
    const { orch } = await setup({
      replay: {
        record: () => {
          throw new Error("缓冲挂了");
        },
        reset: () => {},
      },
    });
    // record 在 publish 里被调用;它抛错不该冒泡成运行失败
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });

  it("取分支锚点失败时回退到会话最新状态,不中断", async () => {
    const { orch, sessions } = await setup({ runAnchor: boom });
    await sessions.setSdkSessionId("s1", "sdk-prev");
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, signal()),
    ).resolves.toMatchObject({ status: "success" });
  });
});

describe("故障注入 / worker 韧性", () => {
  class TestRepo extends InMemoryRunRepo {
    private prompts = new Map<string, string>();
    failNextComplete = false;
    async seed(id: string, sessionId: string, prompt: string) {
      await this.create({ id, sessionId });
      this.prompts.set(id, prompt);
    }
    async getPrompt(id: string): Promise<string | null> {
      return this.prompts.get(id) ?? null;
    }
  }

  async function workerSetup(over: Partial<OrchestratorDeps> = {}) {
    const repo = new TestRepo();
    const { orch } = await setup(over);
    return { repo, worker: new RunWorker(repo, orch, { leaseMs: 5000, heartbeatMs: 60_000 }) };
  }

  it("编排层抛异常时任务落 failed,不会永远卡在 running", async () => {
    const { repo, worker } = await workerSetup();
    // 会话不存在 → 编排层抛错
    await repo.seed("r1", "no-such-session", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect((await repo.get("r1"))?.leaseUntil).toBeNull();
  });

  it("单次失败不杀死 worker 循环:下一个任务照常处理", async () => {
    const { repo, worker } = await workerSetup();
    await repo.seed("bad", "no-such-session", "go");
    await repo.seed("good", "s1", "go");

    await worker.tick(); // 处理坏的
    await worker.tick(); // 处理好的
    expect((await repo.get("bad"))?.state).toBe("failed");
    expect((await repo.get("good"))?.state).toBe("success");
  });

  it("续租失败不影响本轮执行(网络抖动时不该丢任务)", async () => {
    const { repo, worker } = await workerSetup();
    vi.spyOn(repo, "touch").mockRejectedValue(new Error("db 抖动"));
    await repo.seed("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("success");
  });
});
