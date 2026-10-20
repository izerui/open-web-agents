// Worker 测试:用内存 repo + 假引擎,时钟由测试控制,确定性地断言租约与崩溃恢复。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClaudeSdkEngine,
  type QueryFn,
} from "@/lib/modules/agent-engine/adapters/claude-sdk/runner";
import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryChargeWorld } from "@/lib/modules/billing/adapters/in-memory-run-charge-store";
import { RunCharging } from "@/lib/modules/billing/application/run-charging";
import type { BillingMode } from "@/lib/modules/billing/domain/run-charge";
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { platformModels } from "@/lib/modules/model-gateway/application/__tests__/platform-models";
import { FsCostOutbox, InMemoryCostOutbox } from "@/lib/modules/run/adapters/fs-cost-outbox";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { EngineRunFailed, RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { type RunFinalized, RunWorker } from "@/lib/modules/run/application/worker";
import type { CostOutbox, SteerChannel } from "@/lib/modules/run/ports";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext, RunPricing } from "@/lib/shared";
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
    resolveModels: platformModels({ baseUrl: "https://b.example", key: "k" }),
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
    expect(repo.recordedCosts.get("r1")).toEqual({
      input: 900,
      output: 80,
      partial: true,
      pricing: expect.objectContaining({
        providerId: "platform-default",
        models: [
          { capabilityId: "m-sonnet", modelId: "model-sonnet", version: 1 },
          { capabilityId: "m-fable", modelId: "model-fable", version: 1 },
          { capabilityId: "m-opus", modelId: "model-opus", version: 1 },
          { capabilityId: "m-haiku", modelId: "model-haiku", version: 1 },
        ],
      }),
    });
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

describe("RunWorker 受理时模型就不可用", () => {
  it("即使执行时模型已可用:按 model_unavailable 失败,不启动引擎,确认没有用量", async () => {
    const engine = new FakeEngine();
    const settleCalls: boolean[] = [];
    const { repo, worker } = await setup(engine, () => 1000, {
      settleCharge: async (_id, opts) => {
        settleCalls.push(opts.final);
      },
    });
    await repo.create({
      id: "r1",
      sessionId: "s1",
      prompt: "go",
      pricing: { unavailableAtAdmission: { code: "model_disabled", message: "模型已停用" } },
    });
    await worker.tick();
    expect(engine.seenPrompts).toEqual([]);
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect(repo.savedResults.get("r1")?.error).toMatchObject({ kind: "model_unavailable" });
    expect(settleCalls).toEqual([true]);
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
      resolveModels: platformModels({ baseUrl: "https://b.example", key: "k" }),
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

describe("RunWorker 花费写库失败(故障注入)", () => {
  const C = 1_000_000n;
  const priced: Capability = {
    id: "m-main",
    name: "主力",
    kind: "llm",
    modelId: "up-main",
    enabled: true,
    acceptsImages: false,
    providerId: "p",
    rates: [
      { meter: "input_token", units: "1000000", microCredits: "2310000000" },
      { meter: "output_token", units: "1000000", microCredits: "11550000000" },
    ],
    version: 3,
    updatedAt: 0,
  };
  const pricing: RunPricing = {
    providerId: "p",
    models: [{ capabilityId: "m-main", modelId: "up-main", version: 3 }],
    binding: {
      mainRef: "m-main",
      main: "m-main",
      subagents: {},
      slots: { fable: null, opus: null, sonnet: null, haiku: null },
    },
  };
  // 2 万输入 + 1 千输出 = 57.75 积分
  const DUE = 57_750_000n;
  const spent: RunResult = {
    status: "failed",
    cost: {
      input: 20000,
      output: 1000,
      partial: true,
      metering: {
        source: "sdk_model_usage",
        complete: true,
        models: [
          {
            modelId: "up-main",
            inputTokens: 20000,
            outputTokens: 1000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    },
  };

  async function scenario(
    mode: BillingMode,
    failures: number,
    opts: {
      engine?: EnginePort;
      /** 需要在运行中取消本次运行的引擎 */
      makeEngine?: (cancel: () => Promise<unknown>) => EnginePort;
      sessionId?: string;
      steerChannel?: SteerChannel;
      cancel?: boolean;
    } = {},
  ) {
    const world = new InMemoryChargeWorld();
    world.credit("u1", 1000n * C);
    const charging = new RunCharging({
      mode: async () => mode,
      bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as never,
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [priced],
      transaction: world.transaction,
    });
    const ref: { repo?: TestRepo } = {};
    // 默认:运行中被取消,引擎照样返回已经花掉的钱
    const engine =
      opts.engine ??
      opts.makeEngine?.(async () => ref.repo?.cancel("r1")) ??
      new FakeEngine(spent, async () => {
        if (opts.cancel !== false) await ref.repo?.cancel("r1");
      });
    const { repo } = await setup(engine);
    ref.repo = repo;
    const sessions = new InMemorySessionRepo();
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1", source: "web" });
    const orchestrator = new RunOrchestrator({
      sessions,
      agents: new InMemoryAgentRepo([
        { id: "a1", ownerId: "u1", name: "智能体", config: { systemPrompt: "p", model: "sonnet" } },
      ]),
      engine,
      bus: new InMemoryBus(),
      resolveModels: platformModels({ baseUrl: "https://b.example", key: "k" }),
      steerChannel: opts.steerChannel,
    });
    // 计费看到的运行状态 = 库里的:只认真正写进去的花费
    const sync = async () => {
      const r = await repo.get("r1");
      world.setRun("r1", {
        status: r?.state ?? "pending",
        cost: repo.recordedCosts.get("r1") ?? null,
        pricing,
        startedAt: 1,
      });
    };
    const settleCalls: boolean[] = [];
    const worker = new RunWorker(
      repo,
      orchestrator,
      { leaseMs: 1000, heartbeatMs: 10_000, now: () => 1000, costRetries: 2, costRetryMs: 1 },
      {
        settleCharge: async (id, opts) => {
          settleCalls.push(opts.final);
          await sync();
          return charging.settle(id, opts);
        },
        sweepCharges: async () => {
          await sync();
          return charging.sweep();
        },
      },
    );
    let left = failures;
    const record = repo.recordCost.bind(repo);
    repo.recordCost = async (id, cost) => {
      if (left-- > 0) throw new Error("db down");
      return record(id, cost);
    };
    await world.transaction(async (store) => {
      await charging.admit(store, { runId: "r1", accountId: "u1", apiKeyId: null, main: "m-main" });
    });
    await repo.createWithPrompt("r1", opts.sessionId ?? "s1", "go");
    await worker.tick();
    return { world, worker, repo, settleCalls };
  }

  for (const mode of ["live", "trial"] as const) {
    const charged = mode === "live" ? DUE : 0n;

    it(`${mode}:第一次写失败、立即重试成功 → 直接最终结算,只记一次`, async () => {
      const { world, worker, settleCalls } = await scenario(mode, 1);
      expect(settleCalls).toEqual([true]);
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        estimatedMicro: DUE.toString(),
        chargedMicro: charged.toString(),
      });
      await worker.reclaim();
      expect(world.balance("u1")).toEqual({ available: 1000n * C - charged, reserved: 0n });
    });

    it(`${mode}:立即重试也失败 → 中间不按 0 结清(暂记、不完整);回收循环重试写成后补齐,只记一次`, async () => {
      const { world, worker, repo, settleCalls } = await scenario(mode, 2);
      expect(repo.recordedCosts.has("r1")).toBe(false);
      expect(worker.health().pendingCosts).toBe(1);
      expect(settleCalls).toEqual([false]);
      expect(world.charge("r1")).toMatchObject({
        state: "provisional",
        incomplete: true,
        chargedMicro: "0",
      });
      // 冻结已释放,但没有被当成"没有用量"结清
      expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });

      await worker.reclaim(); // 回收循环:重试写入成功 → 最终结算
      expect(worker.health().pendingCosts).toBe(0);
      expect(repo.recordedCosts.get("r1")).toBeTruthy();
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        estimatedMicro: DUE.toString(),
        chargedMicro: charged.toString(),
      });
      expect(world.balance("u1")).toEqual({ available: 1000n * C - charged, reserved: 0n });

      // 再回收、再清扫都不重复扣
      await worker.reclaim();
      await worker.reclaim();
      expect(world.balance("u1")).toEqual({ available: 1000n * C - charged, reserved: 0n });
      expect(world.charge("r1")?.chargedMicro).toBe(charged.toString());
    });
  }

  it("引擎已返回非零花费、追加消息收尾抛错:结果与花费保住,按实际最终结算", async () => {
    // 追加消息通道:收尾时取消订阅抛错(Redis 断开之类)
    const steerChannel: SteerChannel = {
      offer: async () => "accepted" as never,
      awaitOutcome: async () => "pending",
      open: async () => {},
      take: async () => [],
      close: async () => [],
      settle: async () => {},
      onOffer: () => () => {
        throw new Error("redis gone");
      },
    };
    const engine = new FakeEngine({ ...spent, status: "success", summary: "完成" });
    const { world, repo, settleCalls } = await scenario("live", 0, {
      engine,
      steerChannel,
    });
    expect((await repo.get("r1"))?.state).toBe("success");
    expect(repo.savedResults.get("r1")?.finalText).toBe("完成");
    expect(repo.recordedCosts.get("r1")).toBeTruthy();
    expect(settleCalls).toEqual([true]);
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      chargedMicro: DUE.toString(),
    });
    expect(world.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
  });

  for (const mode of ["live", "trial"] as const) {
    it(`${mode}:引擎抛错、用量未知 → 不按零结清(暂记、不完整),冻结释放待核对`, async () => {
      const engine: EnginePort = {
        run: async () => {
          throw new Error("sdk crashed after calling the model");
        },
      };
      const { world, repo, settleCalls } = await scenario(mode, 0, { engine });
      expect((await repo.get("r1"))?.state).toBe("failed");
      expect(settleCalls).toEqual([false]);
      expect(world.charge("r1")).toMatchObject({ state: "provisional", incomplete: true });
      expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
    });
  }

  it("引擎启动前就失败(会话不存在):确认没有调用模型,按 0 最终结清", async () => {
    const engine = new FakeEngine(spent);
    const { world, settleCalls } = await scenario("live", 0, { engine, sessionId: "missing" });
    expect(engine.seenPrompts).toEqual([]);
    expect(settleCalls).toEqual([true]);
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      chargedMicro: "0",
    });
  });

  describe("真实 ClaudeSdkEngine(只换掉 SDK 的 query)", () => {
    const sdk = (q: QueryFn) =>
      new ClaudeSdkEngine(q, {
        sharedHome: "/data/.agent-home",
        hostHome: "/Users/operator",
        sandboxEnabled: false,
        allowStdioMcp: false,
      });

    for (const mode of ["live", "trial"] as const) {
      it(`${mode}:SDK query 抛错、没收到用量 → 暂记不完整,不按零结清`, async () => {
        const q: QueryFn = () =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s" };
            throw new Error("socket hang up");
          })();
        const { world, settleCalls } = await scenario(mode, 0, { engine: sdk(q) });
        expect(settleCalls).toEqual([false]);
        expect(world.charge("r1")).toMatchObject({ state: "provisional", incomplete: true });
        expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
      });

      it(`${mode}:SDK 流结束没有 result、没有用量 → 暂记不完整,不按零结清`, async () => {
        const q: QueryFn = () =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s" };
          })();
        const { world, settleCalls } = await scenario(mode, 0, { engine: sdk(q) });
        expect(settleCalls).toEqual([false]);
        expect(world.charge("r1")).toMatchObject({ state: "provisional", incomplete: true });
      });
    }

    it("SDK 已给出非零费用 result、追加消息收尾抛错 → 按实际费用最终结算", async () => {
      const steerChannel: SteerChannel = {
        offer: async () => "accepted" as never,
        awaitOutcome: async () => "pending",
        open: async () => {},
        take: async () => [],
        close: async () => [],
        settle: async () => {},
        onOffer: () => () => {
          throw new Error("redis gone");
        },
      };
      const q: QueryFn = () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          yield {
            type: "result",
            subtype: "success",
            result: "完成",
            total_cost_usd: 0.2,
            usage: { input_tokens: 20000, output_tokens: 1000 },
            modelUsage: {
              "up-main": {
                inputTokens: 20000,
                outputTokens: 1000,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            },
          };
        })();
      const { world, repo, settleCalls } = await scenario("live", 0, {
        engine: sdk(q),
        steerChannel,
      });
      expect((await repo.get("r1"))?.state).toBe("success");
      expect(repo.recordedCosts.get("r1")).toBeTruthy();
      expect(settleCalls).toEqual([true]);
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        estimatedMicro: DUE.toString(),
        chargedMicro: DUE.toString(),
      });
      expect(world.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
    });
  });

  describe("部分计量:取消或多轮中断也按已产生的用量结算", () => {
    const sdk = (q: QueryFn) =>
      new ClaudeSdkEngine(q, {
        sharedHome: "/data/.agent-home",
        hostHome: "/Users/operator",
        sandboxEnabled: false,
        allowStdioMcp: false,
      });
    const assistant = (id: string, input: number, output: number) => ({
      type: "assistant",
      message: {
        id,
        model: "up-main",
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: input, output_tokens: output },
      },
    });
    // 1 万输入 = 23.1 积分
    const SECOND = 23_100_000n;

    for (const mode of ["live", "trial"] as const) {
      it(`${mode}:已收到非零 usage → 取消且没有 result → 按锁定价目结算(正式实扣 / 试算预计)`, async () => {
        const { world, repo, settleCalls } = await scenario(mode, 0, {
          makeEngine: (cancel) =>
            sdk(() =>
              (async function* () {
                yield { type: "system", subtype: "init", session_id: "s" };
                yield assistant("m1", 20000, 1000);
                await cancel();
                throw new Error("aborted by user");
              })(),
            ),
        });
        expect((await repo.get("r1"))?.state).toBe("cancelled");
        expect(settleCalls).toEqual([true]);
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          estimatedMicro: DUE.toString(),
          chargedMicro: (mode === "live" ? DUE : 0n).toString(),
        });
        expect(world.balance("u1")).toEqual({
          available: 1000n * C - (mode === "live" ? DUE : 0n),
          reserved: 0n,
        });
      });

      it(`${mode}:result₁ → 追加轮 usage₂ → 抛错 → 第二轮计入、第一轮不重复`, async () => {
        const q: QueryFn = () =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s" };
            yield assistant("m1", 20000, 1000);
            yield {
              type: "result",
              subtype: "success",
              result: "第一轮",
              total_cost_usd: 0.2,
              usage: { input_tokens: 20000, output_tokens: 1000 },
              modelUsage: {
                "up-main": {
                  inputTokens: 20000,
                  outputTokens: 1000,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              },
            };
            yield assistant("m2", 10000, 0);
            throw new Error("socket hang up");
          })();
        const { world, repo } = await scenario(mode, 0, { engine: sdk(q), cancel: false });
        expect((await repo.get("r1"))?.state).toBe("failed");
        const total = DUE + SECOND;
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          estimatedMicro: total.toString(),
          chargedMicro: (mode === "live" ? total : 0n).toString(),
        });
        expect(world.balance("u1").available).toBe(1000n * C - (mode === "live" ? total : 0n));
      });
    }
  });
});

describe("RunWorker 费用恢复记录:先落恢复记录再写库,重启后补写", () => {
  const C = 1_000_000n;
  const priced: Capability = {
    id: "m-main",
    name: "主力",
    kind: "llm",
    modelId: "up-main",
    enabled: true,
    acceptsImages: false,
    providerId: "p",
    rates: [
      { meter: "input_token", units: "1000000", microCredits: "2310000000" },
      { meter: "output_token", units: "1000000", microCredits: "11550000000" },
    ],
    version: 3,
    updatedAt: 0,
  };
  const pricing: RunPricing = {
    providerId: "p",
    models: [{ capabilityId: "m-main", modelId: "up-main", version: 3 }],
    binding: {
      mainRef: "m-main",
      main: "m-main",
      subagents: {},
      slots: { fable: null, opus: null, sonnet: null, haiku: null },
    },
  };
  // 2 万输入 + 1 千输出 = 57.75 积分
  const DUE = 57_750_000n;
  const spent: RunResult = {
    status: "success",
    summary: "完成",
    cost: {
      input: 20000,
      output: 1000,
      metering: {
        source: "sdk_model_usage",
        complete: true,
        models: [
          {
            modelId: "up-main",
            inputTokens: 20000,
            outputTokens: 1000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    },
  };
  const never = () => new Promise<never>(() => {});

  /** 一套"数据库 + 账本 + 本机恢复记录";可以起多个 worker 实例(模拟进程重启) */
  async function world(
    make: () => CostOutbox = () => new InMemoryCostOutbox(),
    /** 换掉编排(模拟编排在落了恢复记录之后卡住或出错) */
    orchestratorOf?: (outbox: CostOutbox) => RunOrchestrator,
  ) {
    const ledger = new InMemoryChargeWorld();
    ledger.credit("u1", 1000n * C);
    const charging = new RunCharging({
      mode: async () => "live",
      bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as never,
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [priced],
      transaction: ledger.transaction,
    });
    const outbox = make();
    const built = await setup(new FakeEngine(spent));
    const repo = built.repo;
    const orchestrator = orchestratorOf?.(outbox) ?? built.orchestrator;
    /** 恢复记录里有没有这次运行 */
    const hasFile = async () => (await outbox.list()).some((x) => x.runId === "r1");
    // 计费看到的运行 = 库里的:费用以 saveResult / recordCost 实际写进去的为准
    const sync = async () => {
      const r = await repo.get("r1");
      ledger.setRun("r1", {
        status: r?.state ?? "pending",
        cost: repo.savedResults.get("r1")?.cost ?? repo.recordedCosts.get("r1") ?? null,
        pricing,
        startedAt: 1,
      });
    };
    /** 一个 worker 进程。faults 只作用于这个实例(模拟这个进程里卡住的调用) */
    const worker = (
      now: number,
      faults: {
        saveResult?: () => Promise<void>;
        recordCost?: () => Promise<void>;
        removeOutbox?: () => Promise<void>;
        enrichCost?: (cost: unknown) => Promise<unknown>;
      } = {},
    ) => {
      const r = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === "saveResult" && faults.saveResult) return faults.saveResult;
          if (prop === "recordCost" && faults.recordCost) return faults.recordCost;
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const box = faults.removeOutbox
        ? {
            save: outbox.save.bind(outbox),
            list: outbox.list.bind(outbox),
            remove: faults.removeOutbox,
          }
        : outbox;
      return new RunWorker(
        r,
        orchestrator,
        { leaseMs: 1000, heartbeatMs: 10_000, now: () => now, costRetries: 2, costRetryMs: 1 },
        {
          costOutbox: box,
          ...(faults.enrichCost ? { enrichCost: faults.enrichCost } : {}),
          settleCharge: async (id, opts) => {
            await sync();
            return charging.settle(id, opts);
          },
          sweepCharges: async () => {
            await sync();
            return charging.sweep();
          },
        },
      );
    };
    await ledger.transaction(async (store) => {
      await charging.admit(store, { runId: "r1", accountId: "u1", apiKeyId: null, main: "m-main" });
    });
    await repo.createWithPrompt("r1", "s1", "go");
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(ok()).toBe(true);
    };
    const charged = () => ledger.charge("r1");
    return { ledger, outbox, worker, until, charged, hasFile };
  }

  it("写库明确失败 → 进程重启:按恢复记录补写完整费用,最终扣款一次", async () => {
    const w = await world();
    const fail = async () => {
      throw new Error("db down");
    };
    await w
      .worker(1000, { saveResult: fail, recordCost: fail })
      .tick()
      .catch(() => {});
    expect((w.outbox as InMemoryCostOutbox).files.has("r1")).toBe(true);

    // 重启后的新进程(租约已过期):回收 → 补写 → 清扫结算
    const restarted = w.worker(10_000);
    await restarted.reclaim();
    expect((w.outbox as InMemoryCostOutbox).files.has("r1")).toBe(false);
    expect(w.charged()).toMatchObject({ state: "settled", chargedMicro: DUE.toString() });
    await restarted.reclaim();
    expect(w.ledger.deducted("u1")).toBe(DUE);
    expect(w.ledger.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
  });

  it("写库还没返回时进程退出:恢复记录已在,重启后补回完整费用(不是更早的部分用量)", async () => {
    const w = await world();
    let release!: () => void;
    const stuck = new Promise<void>((_, reject) => {
      release = () => reject(new Error("process gone"));
    });
    // 数据库一直不返回:第一个进程卡在写结果上
    const first = w
      .worker(1000, { saveResult: () => stuck })
      .tick()
      .catch(() => {});
    await w.until(() => (w.outbox as InMemoryCostOutbox).files.has("r1"));
    expect(w.charged()?.state).toBe("open");

    const restarted = w.worker(10_000);
    await restarted.reclaim();
    expect((w.outbox as InMemoryCostOutbox).files.has("r1")).toBe(false);
    expect(w.charged()).toMatchObject({
      state: "settled",
      incomplete: false,
      estimatedMicro: DUE.toString(),
      chargedMicro: DUE.toString(),
    });
    expect(w.ledger.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });

    release(); // 让卡住的调用收尾,不留悬挂的定时器
    await first;
    expect(w.ledger.deducted("u1")).toBe(DUE);
  });

  it("数据库已写成功、删恢复记录前退出:重启后重放不重复扣款", async () => {
    const w = await world();
    // 第一个进程:费用已写进库,卡在删除恢复记录上(之后的结算没机会做)
    const first = w.worker(1000, { removeOutbox: never }).tick();
    await w.until(() => (w.outbox as InMemoryCostOutbox).files.has("r1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(w.charged()?.state).toBe("open");

    const restarted = w.worker(10_000);
    await restarted.reclaim();
    await restarted.reclaim();
    expect((w.outbox as InMemoryCostOutbox).files.has("r1")).toBe(false);
    expect(w.charged()).toMatchObject({ state: "settled", chargedMicro: DUE.toString() });
    expect(w.ledger.deducted("u1")).toBe(DUE);
    expect(w.ledger.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
    void first;
  });

  it("同一场景用真实的本机文件恢复记录:写库失败 → 新进程从同一目录补写,文件删掉,扣款一次", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owa-outbox-worker-"));
    try {
      const w = await world(() => new FsCostOutbox(path.join(dir, "cost-outbox")));
      const fail = async () => {
        throw new Error("db down");
      };
      await w
        .worker(1000, { saveResult: fail, recordCost: fail })
        .tick()
        .catch(() => {});
      expect(await w.hasFile()).toBe(true);
      await w.worker(10_000).reclaim();
      expect(await w.hasFile()).toBe(false);
      expect(w.charged()).toMatchObject({ state: "settled", chargedMicro: DUE.toString() });
      expect(w.ledger.deducted("u1")).toBe(DUE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("引擎返回非零费用 → 增强费用(查价目版本)一直不返回、进程退出 → 重启补回完整费用,只扣一次", async () => {
    const w = await world();
    let release!: () => void;
    const stuck = new Promise<never>((_, reject) => {
      release = () => reject(new Error("process gone"));
    });
    const first = w
      .worker(1000, { enrichCost: () => stuck })
      .tick()
      .catch(() => {});
    // 增强还卡着:恢复记录里已经是原始费用(带计量与锁定价目引用)
    await w.until(() => (w.outbox as InMemoryCostOutbox).files.has("r1"));
    expect((w.outbox as InMemoryCostOutbox).files.get("r1")).toMatchObject({
      input: 20000,
      output: 1000,
      metering: { complete: true },
    });
    expect(w.charged()?.state).toBe("open");

    const restarted = w.worker(10_000);
    await restarted.reclaim();
    await restarted.reclaim();
    expect((w.outbox as InMemoryCostOutbox).files.has("r1")).toBe(false);
    expect(w.charged()).toMatchObject({
      state: "settled",
      incomplete: false,
      estimatedMicro: DUE.toString(),
      chargedMicro: DUE.toString(),
    });
    expect(w.ledger.deducted("u1")).toBe(DUE);

    release();
    await first;
    expect(w.ledger.deducted("u1")).toBe(DUE);
    expect(w.ledger.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
  });

  it("增强完成后恢复记录被原子覆盖成增强版本", async () => {
    const w = await world();
    let seen: unknown;
    const enrich = async (cost: unknown) => {
      seen = structuredClone((w.outbox as InMemoryCostOutbox).files.get("r1"));
      return { ...(cost as object), creditEstimate: { totalMicroCredits: DUE.toString() } };
    };
    // 删除卡住,好看到覆盖后的内容
    void w.worker(1000, { enrichCost: enrich, removeOutbox: never }).tick();
    await w.until(() => {
      const f = (w.outbox as InMemoryCostOutbox).files.get("r1") as
        | { creditEstimate?: unknown }
        | undefined;
      return !!f?.creditEstimate;
    });
    expect(seen).toMatchObject({ input: 20000 });
    expect((seen as { creditEstimate?: unknown }).creditEstimate).toBeUndefined();
  });

  const withPricing = { ...(spent.cost as object), pricing };
  const savingThen = (after: () => Promise<never>) => (outbox: CostOutbox) =>
    ({
      execute: async (cmd: { runId?: string }) => {
        await outbox.save(cmd.runId ?? "", withPricing);
        return after();
      },
    }) as unknown as RunOrchestrator;

  it("编排已落恢复记录、之后卡住(等待计费检查或记会话锚点时数据库不返回)、进程退出 → 重启补回完整费用,扣一次", async () => {
    const w = await world(undefined, savingThen(never));
    void w.worker(1000).tick();
    await w.until(() => (w.outbox as InMemoryCostOutbox).files.has("r1"));
    const restarted = w.worker(10_000);
    await restarted.reclaim();
    await restarted.reclaim();
    expect(w.charged()).toMatchObject({
      state: "settled",
      incomplete: false,
      chargedMicro: DUE.toString(),
    });
    expect(w.ledger.deducted("u1")).toBe(DUE);
  });

  it("编排已落恢复记录、之后出错:带着费用收尾,按完整费用结算一次", async () => {
    const w = await world(
      undefined,
      // 真实编排在引擎交回之后出错时,会把错误连同已交回的费用一起抛出(EngineRunFailed)
      savingThen(async () => {
        throw new EngineRunFailed(new Error("orchestrator crashed"), withPricing as never);
      }),
    );
    await w.worker(1000).tick();
    expect(w.charged()).toMatchObject({ state: "settled", chargedMicro: DUE.toString() });
    await w.worker(1000).reclaim();
    expect(w.charged()).toMatchObject({ state: "settled", chargedMicro: DUE.toString() });
    await w.worker(1000).reclaim();
    expect(w.ledger.deducted("u1")).toBe(DUE);
  });
});

describe("worker 中途挂掉:真实 runner + 编排写下的用量快照用于结算", () => {
  it("SDK 报了用量后不再返回(进程死了)→ 重启回收 → 按快照计价,保留暂记", async () => {
    const C = 1_000_000n;
    const pricing: RunPricing = {
      providerId: "p",
      models: [{ capabilityId: "m-main", modelId: "up-main", version: 3 }],
      binding: {
        mainRef: "m-main",
        main: "m-main",
        subagents: {},
        slots: { fable: null, opus: null, sonnet: null, haiku: null },
      },
    };
    const priced: Capability = {
      id: "m-main",
      name: "主力",
      kind: "llm",
      modelId: "up-main",
      enabled: true,
      acceptsImages: false,
      providerId: "p",
      rates: [{ meter: "input_token", units: "1000000", microCredits: "2310000000" }],
      version: 3,
      updatedAt: 0,
    };
    const ledger = new InMemoryChargeWorld();
    ledger.credit("u1", 1000n * C);
    const charging = new RunCharging({
      mode: async () => "live",
      bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as never,
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [priced],
      transaction: ledger.transaction,
    });
    const snapshots = new Map<string, unknown>();
    // 真实 runner:报一条 1 万输入的用量,然后永远不再返回
    const engine = new ClaudeSdkEngine(
      () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          yield {
            type: "assistant",
            message: {
              id: "m1",
              model: "up-main",
              content: [{ type: "text", text: "x" }],
              usage: { input_tokens: 10000, output_tokens: 0 },
            },
          };
          await new Promise(() => {});
        })(),
      { sharedHome: "/h", hostHome: "/u", sandboxEnabled: false, allowStdioMcp: false },
    );
    const { repo } = await setup(engine);
    const sessions = new InMemorySessionRepo();
    await sessions.create({ id: "s1", agentId: "a1", workspaceDir: "/ws/s1" });
    const orchestrator = new RunOrchestrator({
      sessions,
      agents: new InMemoryAgentRepo([
        { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "sonnet" } },
      ]),
      engine,
      bus: new InMemoryBus(),
      resolveModels: platformModels({ baseUrl: "https://b.example", key: "k" }),
      saveUsageSnapshot: async (runId, cost) => {
        snapshots.set(runId, structuredClone(cost));
      },
    });
    const sync = async () => {
      const r = await repo.get("r1");
      ledger.setRun("r1", {
        status: r?.state ?? "pending",
        cost: repo.recordedCosts.get("r1") ?? null,
        usageSnapshot: snapshots.get("r1") ?? null,
        pricing,
        startedAt: 1,
      });
    };
    const worker = (now: number) =>
      new RunWorker(
        repo,
        orchestrator,
        { leaseMs: 1000, heartbeatMs: 10_000, now: () => now },
        {
          settleCharge: async (id, opts) => {
            await sync();
            return charging.settle(id, opts);
          },
          sweepCharges: async () => {
            await sync();
            return charging.sweep();
          },
        },
      );
    await ledger.transaction((store) =>
      charging.admit(store, { runId: "r1", accountId: "u1", apiKeyId: null, main: "m-main" }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    void worker(1000).tick(); // 卡死在 SDK 上
    for (let i = 0; i < 100 && !snapshots.has("r1"); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(snapshots.get("r1")).toMatchObject({
      input: 10000,
      metering: { models: [{ modelId: "up-main", inputTokens: 10000 }] },
    });

    await worker(10_000).reclaim(); // 租约过期:回收判失败 → 清扫按快照结算
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect(ledger.charge("r1")).toMatchObject({
      state: "provisional",
      incomplete: true,
      estimatedMicro: "23100000",
      chargedMicro: "23100000",
    });
    expect(ledger.deducted("u1")).toBe(23_100_000n);
  });
});
