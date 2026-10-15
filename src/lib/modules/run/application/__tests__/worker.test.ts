// Worker 测试:用内存 repo + 假引擎,时钟由测试控制,确定性地断言租约与崩溃恢复。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { type RunFinalized, RunWorker } from "@/lib/modules/run/application/worker";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

/** 内存 repo + 结果存储,凑齐 worker 需要的 RunRepo & RunPayloadSource。 */
class TestRepo extends InMemoryRunRepo {
  readonly recordedCosts = new Map<string, unknown>();
  async recordCost(id: string, cost: unknown): Promise<void> {
    if (!this.recordedCosts.has(id)) this.recordedCosts.set(id, cost);
  }
  readonly savedResults = new Map<
    string,
    {
      finalText?: string;
      structured?: unknown;
      salvaged?: boolean;
      cost?: unknown;
      error?: unknown;
    }
  >();

  async createWithPrompt(id: string, sessionId: string, prompt: string) {
    await this.create({ id, sessionId, prompt });
  }

  async saveResult(
    id: string,
    data: {
      finalText?: string;
      structured?: unknown;
      salvaged?: boolean;
      cost?: unknown;
      error?: unknown;
    },
  ): Promise<void> {
    this.savedResults.set(id, data);
  }
}

class FakeEngine implements EnginePort {
  seenPrompts: string[] = [];
  seenSpecs: AgentSpec[] = [];
  seenCtx: RunContext[] = [];
  constructor(
    private readonly result: RunResult = { status: "success", summary: "ok" },
    private readonly onRun?: () => void | Promise<void>,
  ) {}
  async run(
    _spec: AgentSpec,
    ctx: RunContext,
    _onEvent: (e: AgentEvent) => void,
    _signal: AbortSignal,
  ): Promise<RunResult> {
    this.seenPrompts.push(ctx.prompt);
    this.seenSpecs.push(_spec);
    this.seenCtx.push(ctx);
    await this.onRun?.();
    return this.result;
  }
}

async function setup(
  engine: EnginePort,
  now: () => number = () => 1000,
  hooks: ConstructorParameters<typeof RunWorker>[3] = {},
) {
  const repo = new TestRepo();
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    { id: "a1", ownerId: "u1", name: "智能体", config: { systemPrompt: "p", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1" });
  await sessions.create({ id: "s2", agentId: "a1", workspaceDir: "/ws/s2" });

  const orchestrator = new RunOrchestrator({
    sessions,
    agents,
    engine,
    bus: new InMemoryBus(),
    platformCredentials: { baseUrl: "b", key: "k" },
  });
  const worker = new RunWorker(
    repo,
    orchestrator,
    {
      leaseMs: 1000,
      heartbeatMs: 10_000,
      now,
    },
    hooks,
  );
  return { repo, worker, orchestrator, agents };
}

describe("RunWorker.tick", () => {
  it("队列为空时不处理任何任务", async () => {
    const { worker } = await setup(new FakeEngine());
    expect(await worker.tick()).toBe(false);
  });

  it("认领队列里的任务并把 prompt 交给引擎", async () => {
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine);
    await repo.createWithPrompt("r1", "s1", "做个视频");

    expect(await worker.tick()).toBe(true);
    expect(engine.seenPrompts).toEqual(["做个视频"]);
  });

  it("成功执行后 run 落 success 终态并清租约", async () => {
    const { repo, worker } = await setup(new FakeEngine());
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();

    const run = await repo.get("r1");
    expect(run?.state).toBe("success");
    expect(run?.leaseUntil).toBeNull();
  });

  it("成功执行后保存最终文本投影", async () => {
    const { repo, worker } = await setup(
      new FakeEngine({ status: "success", summary: "最终回答" }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect(repo.savedResults.get("r1")?.finalText).toBe("最终回答");
  });

  it("结构化结果是从文本里提取的:salvaged 一并落库(对外结果契约要带上这条降级信号)", async () => {
    const { repo, worker } = await setup(
      new FakeEngine({
        status: "success",
        summary: '{"ok":1}',
        structured: { ok: 1 },
        salvagedFromText: true,
      }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect(repo.savedResults.get("r1")).toMatchObject({ structured: { ok: 1 }, salvaged: true });
  });

  it("引擎返回失败时 run 落 failed", async () => {
    const { repo, worker } = await setup(
      new FakeEngine({ status: "failed", error: { kind: "x", message: "炸" } }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
  });

  it("编排抛异常时 run 也落 failed,不会永远卡在 running", async () => {
    const engine = new FakeEngine();
    const { repo, worker, orchestrator } = await setup(engine);
    vi.spyOn(orchestrator, "execute").mockRejectedValueOnce(new Error("boom"));
    await repo.createWithPrompt("r1", "s1", "go");

    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
  });

  it("处理完的任务不会被再次认领", async () => {
    const { repo, worker } = await setup(new FakeEngine());
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect(await worker.tick()).toBe(false);
  });

  it("多个任务逐个处理完", async () => {
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine);
    await repo.createWithPrompt("r1", "s1", "一");
    await repo.createWithPrompt("r2", "s1", "二");

    await worker.tick();
    await worker.tick();
    expect(engine.seenPrompts.sort()).toEqual(["一", "二"]);
    expect(await worker.tick()).toBe(false);
  });
});

describe("RunWorker.reclaim", () => {
  it("【至多一次】孤儿任务判失败并通知等待方,不会被别的 worker 重跑", async () => {
    // worker A 在 t=1000 认领,租约到 2000 后崩溃
    let clock = 1000;
    const finalized: RunFinalized[] = [];
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine, () => clock, {
      onFinalized: (i) => {
        finalized.push(i);
      },
    });
    await repo.createWithPrompt("r1", "s1", "go");
    await repo.claimNext(1000, 1000);

    // 时间推到租约之后
    clock = 5000;
    expect(await worker.reclaim()).toBe(1);
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect(finalized.map((f) => [f.runId, f.state, f.result.error?.kind])).toEqual([
      ["r1", "failed", "worker_lost"],
    ]);

    // 存活的 worker 不会再把它捡起来执行一遍
    expect(await worker.tick()).toBe(false);
    expect(engine.seenPrompts).toEqual([]);
  });

  it("不回收租约仍有效的任务", async () => {
    let clock = 1000;
    const { repo, worker } = await setup(new FakeEngine(), () => clock);
    await repo.createWithPrompt("r1", "s1", "go");
    await repo.claimNext(1000, 1000);

    clock = 1500; // 租约到 2000,尚未过期
    expect(await worker.reclaim()).toBe(0);
  });
});

describe("RunWorker 终态通知", () => {
  it("落库之后才通知,且通知里的状态与库里一致", async () => {
    const seenAtNotify: (string | undefined)[] = [];
    const ref: { repo?: TestRepo } = {};
    const { repo, worker } = await setup(new FakeEngine(), () => 1000, {
      onFinalized: async (i) => {
        seenAtNotify.push((await ref.repo?.get(i.runId))?.state);
      },
    });
    ref.repo = repo;
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect(seenAtNotify).toEqual(["success"]);
  });

  it("运行中被取消:不写结果、不通知 —— 终态由取消方负责", async () => {
    const finalized: RunFinalized[] = [];
    const ref: { repo?: TestRepo } = {};
    const engine = new FakeEngine({ status: "success", summary: "ok" }, async () => {
      await ref.repo?.cancel("r1");
    });
    const { repo, worker } = await setup(engine, () => 1000, {
      onFinalized: (i) => {
        finalized.push(i);
      },
    });
    ref.repo = repo;
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("cancelled");
    expect(finalized).toEqual([]);
  });

  it("运行中被取消:结果作废,但花掉的钱照样入账", async () => {
    const ref: { repo?: TestRepo } = {};
    const engine = new FakeEngine(
      { status: "failed", cost: { input: 900, output: 80, partial: true } },
      async () => {
        await ref.repo?.cancel("r1");
      },
    );
    const { repo, worker } = await setup(engine);
    ref.repo = repo;
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("cancelled");
    expect(repo.recordedCosts.get("r1")).toEqual({ input: 900, output: 80, partial: true });
  });

  it("通知抛错不影响终态", async () => {
    const { repo, worker } = await setup(new FakeEngine(), () => 1000, {
      onFinalized: () => {
        throw new Error("bus down");
      },
    });
    await repo.createWithPrompt("r1", "s1", "go");
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("success");
  });
});

describe("RunWorker 载荷", () => {
  it("按入队时的配置快照执行,而不是执行时的当前配置", async () => {
    const engine = new FakeEngine();
    const { repo, worker, agents } = await setup(engine);
    await repo.create({
      id: "r1",
      sessionId: "s1",
      prompt: "go",
      agentConfig: { systemPrompt: "入队时的提示词", model: "sonnet" },
    });
    // 排队期间配置被改
    await agents.upsert({
      id: "a1",
      ownerId: "u1",
      name: "智能体",
      config: { systemPrompt: "改过的提示词", model: "sonnet" },
    });
    await worker.tick();
    expect(engine.seenSpecs[0]?.systemPrompt).toContain("入队时的提示词");
  });

  it("旧任务的用户凭证覆盖即使成功解密也不会替换平台 Key", async () => {
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine, () => 1000, {
      decodeOverride: (enc) => JSON.parse(enc.replace(/^enc:/, "")),
    });
    await repo.create({
      id: "r1",
      sessionId: "s1",
      prompt: "go",
      overrideEnc: `enc:${JSON.stringify({ key: "caller-key" })}`,
    });
    await worker.tick();
    expect(engine.seenCtx[0]?.credentials.key).toBe("k");
  });

  it("覆盖解不开:本轮失败,绝不回落到平台凭证", async () => {
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine, () => 1000, {
      decodeOverride: () => {
        throw new Error("无法解密");
      },
    });
    await repo.create({ id: "r1", sessionId: "s1", prompt: "go", overrideEnc: "garbage" });
    await worker.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect(engine.seenPrompts).toEqual([]);
  });
});

describe("RunWorker 并发", () => {
  it("不同会话的运行并行执行(一个卡在审批上不挡住另一个)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    const engine: EnginePort = {
      async run(_s, ctx) {
        started.push(ctx.sessionId);
        if (ctx.sessionId === "s1") await gate; // s1 一直等"审批"
        return { status: "success", summary: "ok" };
      },
    };
    const repo = new TestRepo();
    const sessions = new InMemorySessionRepo();
    const agents = new InMemoryAgentRepo([
      { id: "a1", ownerId: "u1", name: "智能体", config: { systemPrompt: "p", model: "sonnet" } },
    ]);
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1" });
    await sessions.create({ id: "s2", agentId: "a1", workspaceDir: "/ws/s2" });
    const orchestrator = new RunOrchestrator({
      sessions,
      agents,
      engine,
      bus: new InMemoryBus(),
      platformCredentials: { baseUrl: "b", key: "k" },
    });
    const worker = new RunWorker(repo, orchestrator, { concurrency: 2, idleMs: 5 });
    await repo.createWithPrompt("r1", "s1", "慢");
    await repo.createWithPrompt("r2", "s2", "快");

    worker.start();
    for (let i = 0; i < 200 && (await repo.get("r2"))?.state !== "success"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await repo.get("r2"))?.state).toBe("success");
    expect((await repo.get("r1"))?.state).toBe("running");

    release();
    worker.stop();
    expect(await worker.drain(2000)).toBe(true);
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("abortInFlight 让在途运行立刻走收尾路径落 failed", async () => {
    const stuck: EnginePort = {
      run: (_s, _c, _e, signal) =>
        new Promise<RunResult>((resolve) => {
          const done = () =>
            resolve({ status: "failed", error: { kind: "aborted", message: "中止" } });
          if (signal.aborted) done();
          else signal.addEventListener("abort", done);
        }),
    };
    const { repo, worker } = await setup(stuck, () => Date.now());
    await repo.createWithPrompt("r1", "s1", "卡住");
    worker.start();
    for (let i = 0; i < 200 && (await repo.get("r1"))?.state !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    worker.stop();
    expect(worker.abortInFlight()).toBe(1);
    expect(await worker.drain(2000)).toBe(true);
    expect((await repo.get("r1"))?.state).toBe("failed");
  });
});

describe("RunWorker 取消通知", () => {
  it("收到取消通知立即中止,不等下一次心跳", async () => {
    let fire: (runId: string) => void = () => {};
    const cancelSignal = {
      publish: async () => {},
      subscribe: (cb: (runId: string) => void) => {
        fire = cb;
        return () => {};
      },
    };
    let aborted = false;
    let started = false;
    const stuck: EnginePort = {
      run: (_s, _c, _e, signal) =>
        new Promise<RunResult>((resolve) => {
          started = true;
          const done = () => {
            aborted = true;
            resolve({ status: "failed", error: { kind: "aborted", message: "中止" } });
          };
          if (signal.aborted) done();
          else signal.addEventListener("abort", done);
        }),
    };
    const { repo, worker } = await setup(stuck, () => Date.now(), { cancelSignal });
    await repo.createWithPrompt("r1", "s1", "长任务");
    worker.start(); // 心跳 10 秒一次,测试窗口里不会触发
    // 等引擎真正跑起来(准备阶段就被中止的运行根本不会启动引擎)
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    const start = Date.now();
    await repo.cancel("r1");
    fire("r1");
    for (let i = 0; i < 200 && !aborted; i++) await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
    expect((await repo.get("r1"))?.state).toBe("cancelled");
    worker.stop();
    await worker.drain(2000);
  });
});

describe("RunWorker 生命周期", () => {
  it("start 后自动消费队列,stop 后停止", async () => {
    const engine = new FakeEngine();
    const { repo, worker } = await setup(engine, () => Date.now());
    await repo.createWithPrompt("r1", "s1", "自动跑");

    worker.start();
    // 等它把任务消费掉。预算给足 —— 与构建并发时 1s 曾经不够
    for (let i = 0; i < 250 && (await repo.get("r1"))?.state !== "success"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    worker.stop();

    expect((await repo.get("r1"))?.state).toBe("success");
    expect(engine.seenPrompts).toEqual(["自动跑"]);
  });
});

describe("RunWorker 墙钟超时", () => {
  it("超时后中断运行并落 failed,不让 worker 被永久占住", async () => {
    // 模拟"卡在网络调用上"的引擎:只有被 abort 才返回
    const stuckEngine: EnginePort = {
      async run(_s, _c, _e, signal) {
        return new Promise<RunResult>((resolve) => {
          if (signal.aborted) {
            resolve({ status: "failed", error: { kind: "aborted", message: "已中断" } });
            return;
          }
          signal.addEventListener("abort", () =>
            resolve({ status: "failed", error: { kind: "aborted", message: "已中断" } }),
          );
        });
      },
    };
    const { repo, worker } = await setup(stuckEngine, () => Date.now());
    // 极短超时便于测试
    const fast = new RunWorker(repo, (await setup(stuckEngine, () => Date.now())).orchestrator, {
      leaseMs: 10_000,
      heartbeatMs: 10_000,
      maxDurationMs: 30,
    });
    await repo.createWithPrompt("r1", "s1", "会卡住的任务");

    await fast.tick();
    expect((await repo.get("r1"))?.state).toBe("failed");
    // 关键:租约已清,worker 不再被占
    expect((await repo.get("r1"))?.leaseUntil).toBeNull();
    void worker;
  });

  it("正常完成的任务不受超时影响", async () => {
    const { repo, orchestrator } = await setup(new FakeEngine(), () => Date.now());
    const w = new RunWorker(repo, orchestrator, { maxDurationMs: 60_000 });
    await repo.createWithPrompt("r1", "s1", "快任务");
    await w.tick();
    expect((await repo.get("r1"))?.state).toBe("success");
  });

  it("enrichCost hook 增强 cost 后持久化,hook 抛错时原始 cost 仍保存", async () => {
    const metering = {
      source: "sdk_model_usage" as const,
      complete: true,
      models: [
        {
          modelId: "m1",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    };
    const costWithMetering = { usd: 0.01, input: 100, output: 50, metering };
    let enrichCalls = 0;

    // Run 1: enrichCost succeeds
    const engine1 = new FakeEngine({ status: "success", summary: "ok", cost: costWithMetering });
    const { repo: repo1, worker: w1 } = await setup(engine1, () => 1000, {
      enrichCost: async (raw) => {
        enrichCalls++;
        return {
          ...(raw as Record<string, unknown>),
          creditEstimate: {
            totalMicroCredits: "42",
            complete: true,
            source: "sdk_model_usage",
            models: [],
          },
        };
      },
    });
    await repo1.createWithPrompt("r1", "s1", "go");
    await w1.tick();
    const saved1 = repo1.savedResults.get("r1")?.cost as Record<string, unknown> | undefined;
    expect(saved1?.creditEstimate).toBeDefined();
    expect((saved1?.creditEstimate as { totalMicroCredits: string }).totalMicroCredits).toBe("42");
    expect(saved1?.usd).toBe(0.01);
    expect(enrichCalls).toBe(1);

    // Run 2: enrichCost throws — original cost still saved without creditEstimate
    const engine2 = new FakeEngine({ status: "success", summary: "ok", cost: costWithMetering });
    const { repo: repo2, worker: w2 } = await setup(engine2, () => 1000, {
      enrichCost: async () => {
        throw new Error("enrichment failed");
      },
    });
    await repo2.createWithPrompt("r2", "s1", "go");
    await w2.tick();
    const saved2 = repo2.savedResults.get("r2")?.cost as Record<string, unknown> | undefined;
    expect(saved2?.usd).toBe(0.01);
    expect(saved2?.metering).toBeDefined();
    expect(saved2?.creditEstimate).toBeUndefined();
    expect((await repo2.get("r2"))?.state).toBe("success");
  });
});
