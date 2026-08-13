// 故障注入:把每个可选依赖依次打挂,验证运行【降级而非崩溃】。
//
// 之前所有验证都在"依赖都正常"的前提下做的。但代码里写了不少降级路径 ——
// 事件发不出去、知识检索挂了、凭证解不开、回调打不通、审计写入失败……
// 这些分支从没被真正触发过,而它们恰恰是生产环境最先遇到的。
//
// 判断标准统一:【任何辅助能力的故障,都不该让用户的这一轮运行失败】。
// 结果已经算出来了,不能因为"记审计日志失败"就把它丢掉。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
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
  const agents = new InMemoryAgentRepo([
    { id: "a1", ownerId: "u1", name: "智能体", config: { systemPrompt: "p", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws", ownerId: "u1" });

  const orch = new RunOrchestrator({
    sessions,
    agents,
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
    // 提示词退回智能体原始配置,没有被半截的检索结果污染
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

  // 这条曾经断言"取分支锚点失败时回退到会话最新状态,不中断" —— 又一次把 bug 写成规格。
  //
  // 锚点决定这一轮从哪儿起跑。读失败时回落到会话最新锚点,意味着一个"从零重开"的
  // 分支恢复了完整历史对话、悄悄串回主线;更糟的是随后还会把这个错误锚点写进审计轨迹,
  // 事后完全无法诊断"它为什么记得本不该记得的事"。
  // DB 读失败在这里不是可降级条件 —— 宁可让这一轮失败重试。
  it("取分支锚点失败时【中止本轮】,而不是悄悄串回主线", async () => {
    const { orch, sessions } = await setup({ runAnchor: boom });
    await sessions.setSdkSessionId("s1", "sdk-prev");
    await expect(
      orch.execute({ sessionId: "s1", prompt: "hi", runId: "r1" }, signal()),
    ).rejects.toThrow();
  });

  it("没有 runId 时不查锚点,正常跑(网页对话的常规路径)", async () => {
    const { orch } = await setup({ runAnchor: boom });
    await expect(orch.execute({ sessionId: "s1", prompt: "hi" }, signal())).resolves.toMatchObject({
      status: "success",
    });
  });

  it("读用户凭证失败时回落平台默认并继续 —— 但会记一条告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { orch, engine, sessions } = await setup({ userCredentials: boom });
    await sessions.create({ id: "s-own", agentId: "a1", workspaceDir: "/ws", ownerId: "u1" });
    await expect(
      orch.execute({ sessionId: "s-own", prompt: "hi" }, signal()),
    ).resolves.toMatchObject({ status: "success" });
    expect(engine.lastCtx?.credentials).toEqual({ baseUrl: "platform", key: "pk" });
    // 静默换用平台 key = 计费记错账却无人知晓,必须留下痕迹
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  // 续租的两种失败必须区别对待,这是曾经栽过的地方:
  // - 抛异常 = 网络抖动,下一拍还有机会,不该丢任务
  // - 返回 false = 【已经失去租约】,任务已被别人接手,必须立刻收手
  //
  // 当初两者都被 `.catch(() => {})` 吞成同一件事,而且测试还断言了"续租失败不影响
  // 本轮执行" —— 把 bug 写成了规格。那条断言在单 worker、心跳压根不触发的条件下
  // 永远是绿的,真实时序下则是同一任务被执行两次。
  it("续租抛异常(网络抖动)不影响本轮执行 —— 不该因为一次抖动丢任务", async () => {
    const { repo, worker } = await workerSetup();
    vi.spyOn(repo, "touch").mockRejectedValue(new Error("db 抖动"));
    await repo.seed("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("【双执行回归】续租返回 false = 已失租,立刻中止且不写库", async () => {
    const repo = new TestRepo();
    // 引擎必须真的耗时:瞬时返回的引擎会在第一次心跳之前就跑完,
    // 于是"失租"这个分支根本进不去 —— 测试绿了却什么都没验到。
    class SlowEngine extends OkEngine {
      async run(
        spec: AgentSpec,
        ctx: RunContext,
        onEvent: (e: AgentEvent) => void,
        signal: AbortSignal,
      ) {
        await new Promise((r) => setTimeout(r, 30));
        return super.run(spec, ctx, onEvent, signal);
      }
    }
    const { orch } = await setup({}, new SlowEngine());
    const worker = new RunWorker(repo, orch, { leaseMs: 5000, heartbeatMs: 1 });
    vi.spyOn(repo, "touch").mockResolvedValue(false); // 租约已被回收
    const saved = vi.spyOn(repo, "complete");

    await repo.seed("r1", "s1", "go");
    await worker.tick();

    // 关键:失租的 worker 不得把自己的结果写进去 —— 那正是覆写接手者结果的路径
    expect(saved).not.toHaveBeenCalled();
    expect((await repo.get("r1"))?.state).toBe("running");
  });

  it("栅栏令牌:令牌作废后 complete 是空操作,写不进终态", async () => {
    const repo = new TestRepo();
    await repo.seed("r1", "s1", "go");
    const first = await repo.claimNext(1000, 1000);
    expect(first?.fence).toBeTruthy();

    // 租约过期,任务被另一个 worker 接手 → 换了新令牌
    const second = await repo.claimNext(5000, 9000);
    expect(second?.id).toBe("r1");
    expect(second?.fence).not.toBe(first?.fence);

    // 僵尸 worker 拿着旧令牌回来写结果
    expect(await repo.complete("r1", "failed", first?.fence)).toBe(false);
    expect((await repo.get("r1"))?.state).toBe("running");
    // 接手者用新令牌写得进去
    expect(await repo.complete("r1", "success", second?.fence)).toBe(true);
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("终态不可被重入覆写 —— 状态机的规矩必须在写入边界上强制", async () => {
    const repo = new TestRepo();
    await repo.seed("r1", "s1", "go");
    const c = await repo.claimNext(5000, 1000);
    expect(await repo.complete("r1", "success", c?.fence)).toBe(true);
    // 已是终态,任何后续写入都不该生效(包括把 success 翻成 failed)
    expect(await repo.complete("r1", "failed")).toBe(false);
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("缺 prompt 的运行落 failed,而不是拿空提示词跑一遍再报成功", async () => {
    const repo = new TestRepo();
    const { orch } = await setup();
    const worker = new RunWorker(repo, orch, { leaseMs: 5000, heartbeatMs: 60_000 });
    await repo.create({ id: "r1", sessionId: "s1" }); // 没 seed prompt
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
  });
});

// 关停。之前是 stop() 之后固定 setTimeout 5 秒就 process.exit(0),从不追踪在途
// promise —— 而 maxDurationMs 默认 30 分钟,几乎所有真实运行都会被中途砍掉,
// 行留在 running 直到租约过期,再被别的 worker 从头重跑,正是注释声称要避免的
// 「重复执行副作用」。注释描述的是意图,代码做的是相反的事。
describe("关停 / drain 真的等在途任务", () => {
  class TestRepo extends InMemoryRunRepo {
    private prompts = new Map<string, string>();
    async seed(id: string, sessionId: string, prompt: string) {
      await this.create({ id, sessionId });
      this.prompts.set(id, prompt);
    }
    async getPrompt(id: string): Promise<string | null> {
      return this.prompts.get(id) ?? null;
    }
  }

  class SlowEngine extends OkEngine {
    async run(
      spec: AgentSpec,
      ctx: RunContext,
      onEvent: (e: AgentEvent) => void,
      signal: AbortSignal,
    ) {
      await new Promise((r) => setTimeout(r, 400));
      return super.run(spec, ctx, onEvent, signal);
    }
  }

  it("stop() 之后 drain 会等到任务真正落终态", async () => {
    const repo = new TestRepo();
    const { orch } = await setup({}, new SlowEngine());
    const worker = new RunWorker(repo, orch, { idleMs: 5, heartbeatMs: 60_000 });

    await repo.seed("r1", "s1", "go");
    worker.start();
    // 等它认领上
    await new Promise((r) => setTimeout(r, 30));

    worker.stop();
    expect(await worker.drain(5000)).toBe(true);
    // 关键:排空之后任务已经是终态,不会留在 running 等租约过期后被重跑
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("宽限期不够时如实返回 false,而不是假装已排空", async () => {
    const repo = new TestRepo();
    const { orch } = await setup({}, new SlowEngine());
    const worker = new RunWorker(repo, orch, { idleMs: 5, heartbeatMs: 60_000 });

    await repo.seed("r1", "s1", "go");
    worker.start();
    await new Promise((r) => setTimeout(r, 30));

    worker.stop();
    // 任务还要跑 ~370ms,20ms 的宽限期必然不够 —— 必须如实返回 false
    expect(await worker.drain(20)).toBe(false);
    worker.stop();
    await worker.drain(5000);
  });

  it("空闲 worker 立刻排空", async () => {
    const repo = new TestRepo();
    const { orch } = await setup();
    const worker = new RunWorker(repo, orch, { idleMs: 5 });
    worker.start();
    worker.stop();
    expect(await worker.drain(2000)).toBe(true);
  });
});
