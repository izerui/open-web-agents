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
  // 缓存读 231 积分/百万(输入的一成),缓存写 2887.5 积分/百万
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
      { meter: "cache_read_token", units: "1000000", microCredits: "231000000" },
      { meter: "cache_write_token", units: "1000000", microCredits: "2887500000" },
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
    /** 再结算一次(重复结算、清扫),走与 worker 相同的同步 */
    const settleAgain = async () => {
      await sync();
      return charging.settle("r1", { final: true });
    };
    const sweepAgain = async () => {
      await sync();
      return charging.sweep();
    };
    return { world, worker, repo, settleCalls, settleAgain, sweepAgain };
  }

  const charged = DUE;

  it("第一次写失败、立即重试成功 → 直接最终结算,只记一次", async () => {
    const { world, worker, settleCalls } = await scenario(1);
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

  it("立即重试也失败 → 中间不按 0 结清(暂记、不完整);回收循环重试写成后补齐,只记一次", async () => {
    const { world, worker, repo, settleCalls } = await scenario(2);
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
    const { world, repo, settleCalls } = await scenario(0, {
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

  it("引擎抛错、一条用量都没收到 → 按规则自动按 0 结清,冻结全部退回", async () => {
    const engine: EnginePort = {
      run: async () => {
        throw new Error("sdk crashed after calling the model");
      },
    };
    const { world, repo, settleCalls } = await scenario(0, { engine });
    expect((await repo.get("r1"))?.state).toBe("failed");
    expect(settleCalls).toEqual([true]);
    expect(world.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      chargedMicro: "0",
    });
    expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
  });

  it("引擎启动前就失败(会话不存在):确认没有调用模型,按 0 最终结清", async () => {
    const engine = new FakeEngine(spent);
    const { world, settleCalls } = await scenario(0, { engine, sessionId: "missing" });
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

    it("SDK query 抛错、没收到用量 → 自动按 0 结清", async () => {
      const q: QueryFn = () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
          throw new Error("socket hang up");
        })();
      const { world, settleCalls } = await scenario(0, { engine: sdk(q) });
      expect(settleCalls).toEqual([true]);
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        chargedMicro: "0",
      });
      expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
    });

    it("SDK 流结束没有 result、没有用量 → 自动按 0 结清", async () => {
      const q: QueryFn = () =>
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "s" };
        })();
      const { world, settleCalls } = await scenario(0, { engine: sdk(q) });
      expect(settleCalls).toEqual([true]);
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        chargedMicro: "0",
      });
    });

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
      const { world, repo, settleCalls } = await scenario(0, {
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

    it("已收到非零 usage → 取消且没有 result → 按锁定价目结算", async () => {
      const { world, repo, settleCalls } = await scenario(0, {
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
        chargedMicro: DUE.toString(),
      });
      expect(world.balance("u1")).toEqual({
        available: 1000n * C - DUE,
        reserved: 0n,
      });
    });

    it("带模型名的消息 → 不带模型名的消息 → 取消:两部分都收费(后者按主模型价),已知部分不重复,重复结算不多扣", async () => {
      const { world, repo, settleCalls, settleAgain, sweepAgain } = await scenario(0, {
        makeEngine: (cancel) =>
          sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield assistant("m1", 10000, 0);
              yield assistant("m1", 10000, 0); // 同一条消息再到一次:不重复
              yield {
                type: "assistant",
                message: {
                  id: "m2",
                  content: [{ type: "text", text: "x" }],
                  usage: { input_tokens: 10000, output_tokens: 0 },
                },
              };
              await cancel();
              throw new Error("aborted by user");
            })(),
          ),
      });
      expect((await repo.get("r1"))?.state).toBe("cancelled");
      expect(settleCalls).toEqual([true]);
      // 已知 1 万(23.1)+ 未归属 1 万按主模型价(23.1)
      const due = 2n * SECOND;
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        estimatedMicro: due.toString(),
        chargedMicro: due.toString(),
      });
      expect(world.balance("u1")).toEqual({ available: 1000n * C - due, reserved: 0n });

      expect(await settleAgain()).toBe("none");
      expect(await sweepAgain()).toBe(0);
      expect(world.charge("r1")?.chargedMicro).toBe(due.toString());
      expect(world.balance("u1")).toEqual({ available: 1000n * C - due, reserved: 0n });
    });

    describe("正常结束:收到缓存用量 → result", () => {
      const cached = (id: string) => ({
        type: "assistant",
        message: {
          id,
          model: "up-main",
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000 },
        },
      });
      const result = (modelUsage?: Record<string, unknown>) => ({
        type: "result",
        subtype: "success",
        result: "好的",
        total_cost_usd: 0.01,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000 },
        ...(modelUsage ? { modelUsage } : {}),
      });
      // 1 万缓存读 × 231 积分/百万 = 2.31 积分(按普通输入价会是 23.1)
      const CACHE_DUE = 2_310_000n;

      for (const [label, modelUsage] of [
        ["result 没有 modelUsage:缓存记为未归属,按主模型的缓存价收费", undefined],
        [
          "对照:result 有完整 modelUsage:按明细收费,之前按消息累计的不重复计",
          {
            "up-main": {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 10000,
              cacheCreationInputTokens: 0,
            },
          },
        ],
      ] as const) {
        it(`${label};重复结算、清扫不多扣`, async () => {
          const q: QueryFn = () =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield cached("m1");
              yield result(modelUsage);
            })();
          const { world, repo, settleAgain, sweepAgain } = await scenario(0, {
            engine: sdk(q),
            cancel: false,
          });
          expect((await repo.get("r1"))?.state).toBe("success");
          expect(world.charge("r1")).toMatchObject({
            state: "settled",
            incomplete: false,
            estimatedMicro: CACHE_DUE.toString(),
            chargedMicro: CACHE_DUE.toString(),
          });
          expect(await settleAgain()).toBe("none");
          expect(await sweepAgain()).toBe(0);
          expect(world.balance("u1")).toEqual({ available: 1000n * C - CACHE_DUE, reserved: 0n });
        });
      }
    });

    describe("result 的 modelUsage 有不合规的项", () => {
      const counts = (input: number, extra: Record<string, unknown> = {}) => ({
        inputTokens: input,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        ...extra,
      });
      const run = (modelUsage: Record<string, unknown>) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield assistant("m1", 10000, 0); // 按消息累计的,会被 result 的累计快照覆盖
              yield {
                type: "result",
                subtype: "success",
                result: "好的",
                total_cost_usd: 0.01,
                usage: { input_tokens: 20000, output_tokens: 0 },
                modelUsage,
              };
            })(),
          ),
          cancel: false,
        });

      it("正常模型明细 + 模型名非法但四项计数有效:两部分都收(后者按主模型价),不重复;重复结算、清扫不多扣", async () => {
        const { world, repo, settleAgain, sweepAgain } = await run({
          "up-main": counts(10000),
          ["x".repeat(201)]: counts(10000),
        });
        expect((await repo.get("r1"))?.state).toBe("success");
        const due = 2n * SECOND;
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          estimatedMicro: due.toString(),
          chargedMicro: due.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - due, reserved: 0n });
      });

      it("有计数读不出(计量缺失):读得出的照扣,保持暂记、不当成结清;重复结算不多扣", async () => {
        const { world, settleAgain, sweepAgain } = await run({
          "up-main": counts(10000),
          other: counts(10000, { outputTokens: "lots" }),
        });
        // 两项的输入都读得出:2 万输入;other 认不出模型,按主模型价
        const due = 2n * SECOND;
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          estimatedMicro: due.toString(),
          chargedMicro: due.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - due, reserved: 0n });
      });
    });

    describe("result 的计量里没有可用的非零计数(没带计量、全是 0、空 modelUsage)", () => {
      const errorResult = {
        type: "result",
        subtype: "error_during_execution",
        result: "执行出错",
        total_cost_usd: 0,
      };
      const run = (observed: boolean, result: Record<string, unknown> = errorResult) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              if (observed) yield assistant("m1", 10000, 0);
              yield result;
            })(),
          ),
          cancel: false,
        });

      it("assistant 已报 1 万输入 → error result 没带计量:按观察到的用量收费(计量标为不完整);重复结算、清扫不多扣", async () => {
        const { world, repo, settleAgain, sweepAgain } = await run(true);
        expect((await repo.get("r1"))?.state).toBe("failed");
        expect(repo.recordedCosts.get("r1")).toMatchObject({
          metering: { complete: false, models: [{ modelId: "up-main", inputTokens: 10000 }] },
        });
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          estimatedMicro: SECOND.toString(),
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("assistant 已报 1 万输入 → error result 的 usage 全是 0:同样按观察到的用量收费", async () => {
        const { world } = await run(true, {
          ...errorResult,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          chargedMicro: SECOND.toString(),
        });
      });

      const zeroCounts = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      for (const [label, extra] of [
        ["modelUsage 为空对象、没有 usage", { modelUsage: {} }],
        [
          "modelUsage 为空对象、usage 全是 0",
          { modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } },
        ],
        ["modelUsage 里的模型全是 0", { modelUsage: { "up-main": zeroCounts } }],
      ] as const) {
        it(`assistant 已报 1 万输入 → error result 的 ${label}:收取那 1 万输入;重复结算、清扫不多扣`, async () => {
          const { world, settleAgain, sweepAgain } = await run(true, { ...errorResult, ...extra });
          expect(world.charge("r1")).toMatchObject({
            state: "settled",
            estimatedMicro: SECOND.toString(),
            chargedMicro: SECOND.toString(),
          });
          expect(await settleAgain()).toBe("none");
          expect(await sweepAgain()).toBe(0);
          expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
        });
      }

      it("assistant 已报 1 万输入 → error result 的 modelUsage 读不出(null):收取那 1 万输入,带着计量缺失保持暂记", async () => {
        const { world } = await run(true, { ...errorResult, modelUsage: null });
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          chargedMicro: SECOND.toString(),
        });
      });

      it("对照:result 带完整累计明细(已含观察到的 1 万输入)→ 由它覆盖,只收一次", async () => {
        const { world, settleAgain } = await run(true, {
          type: "result",
          subtype: "success",
          result: "好的",
          total_cost_usd: 0.01,
          usage: { input_tokens: 10000, output_tokens: 0 },
          modelUsage: { "up-main": { ...zeroCounts, inputTokens: 10000 } },
        });
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("对照:确实没有观察到任何用量 → error result 没带计量:按零结清,冻结全部退回", async () => {
        const { world } = await run(false);
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          chargedMicro: "0",
        });
        expect(world.balance("u1")).toEqual({ available: 1000n * C, reserved: 0n });
      });
    });

    describe("多条 result:后到的结果没有可用计数,不能覆盖前一条已确认的用量", () => {
      const counts = (input: number) => ({
        inputTokens: input,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      const result1 = {
        type: "result",
        subtype: "success",
        result: "第一轮",
        total_cost_usd: 0.02,
        usage: { input_tokens: 10000, output_tokens: 0 },
        modelUsage: { "up-main": counts(10000) },
      };
      const errorResult2 = (extra: Record<string, unknown>) => ({
        type: "result",
        subtype: "error_during_execution",
        result: "追加轮出错",
        total_cost_usd: 0,
        ...extra,
      });
      const run = (between: unknown[], second: unknown) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield assistant("m1", 10000, 0);
              yield result1;
              for (const m of between) yield m; // 追加轮
              yield second;
            })(),
          ),
          cancel: false,
        });

      it("非零完整 result₁ → 无新用量 → error result₂ 带全零 modelUsage:第一轮费用保住、只扣一次;重复结算、清扫不多扣", async () => {
        const { world, repo, settleAgain, sweepAgain } = await run(
          [],
          errorResult2({
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: { "up-main": counts(0) },
          }),
        );
        expect((await repo.get("r1"))?.state).toBe("failed");
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          estimatedMicro: SECOND.toString(),
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("非零完整 result₁ → 无新用量 → error result₂ 的 modelUsage 读不出:第一轮费用保住,带着计量缺失保持暂记", async () => {
        const { world, settleAgain } = await run([], errorResult2({ modelUsage: null }));
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("对照:追加轮有新用量、result₂ 带完整累计明细:由它覆盖,两轮合计只扣一次", async () => {
        const { world } = await run(
          [assistant("m2", 5000, 0)],
          errorResult2({
            usage: { input_tokens: 5000, output_tokens: 0 },
            modelUsage: { "up-main": counts(15000) },
          }),
        );
        // 1.5 万输入 = 34.65 积分
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          chargedMicro: "34650000",
        });
      });
    });

    describe("result 的 modelUsage 没有可用计数、usage 有(没有先前的消息用量可兜底)", () => {
      const counts = (input: number, extra: Record<string, unknown> = {}) => ({
        inputTokens: input,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        ...extra,
      });
      const onlyResult = (modelUsage: Record<string, unknown>, input: number) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield {
                type: "result",
                subtype: "success",
                result: "好的",
                total_cost_usd: 0.01,
                usage: { input_tokens: input, output_tokens: 0 },
                modelUsage,
              };
            })(),
          ),
          cancel: false,
        });

      it("modelUsage 全零、usage 报 1 万输入:按主模型价收费一次;重复结算、清扫不多扣", async () => {
        const { world, settleAgain, sweepAgain } = await onlyResult(
          { "up-main": counts(0) },
          10000,
        );
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          estimatedMicro: SECOND.toString(),
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("modelUsage 全零且有读不出的计数、usage 报 1 万输入:照收,带着计量缺失保持暂记", async () => {
        const { world } = await onlyResult({ "up-main": counts(0, { outputTokens: -1 }) }, 10000);
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          chargedMicro: SECOND.toString(),
        });
      });

      it("对照:modelUsage 有效非零时以它为准,不叠加 usage", async () => {
        const { world } = await onlyResult({ "up-main": counts(10000) }, 30000);
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          chargedMicro: SECOND.toString(),
        });
      });
    });

    describe("多条 result:后到的累计快照部分字段读不出", () => {
      const usage = (input: number, output: unknown) => ({
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      const run = (second: Record<string, unknown>) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield assistant("m1", 10000, 1000);
              yield {
                type: "result",
                subtype: "success",
                result: "第一轮",
                total_cost_usd: 0.02,
                usage: { input_tokens: 10000, output_tokens: 1000 },
                modelUsage: { "up-main": usage(10000, 1000) },
              };
              yield assistant("m2", 10000, 0); // 追加轮
              yield {
                type: "result",
                subtype: "error_during_execution",
                result: "追加轮出错",
                total_cost_usd: 0.03,
                ...second,
              };
            })(),
          ),
          cancel: false,
        });

      it("result₁ 确认 1 万输入 + 1000 输出 → result₂ 累计输入 2 万、输出读不出:按 2 万输入 + 1000 输出扣已知部分,保持暂记;重复结算、清扫不多扣", async () => {
        const { world, settleAgain, sweepAgain } = await run({
          modelUsage: { "up-main": usage(20000, "unreadable") },
        });
        // 2 万输入 46.2 + 1000 输出 11.55 = 57.75
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          estimatedMicro: DUE.toString(),
          chargedMicro: DUE.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
      });

      describe("身份在后续累计明细里被修正:旧数量不再另加", () => {
        const corrected = (firstModelUsage: Record<string, unknown>) =>
          scenario(0, {
            engine: sdk(() =>
              (async function* () {
                yield { type: "system", subtype: "init", session_id: "s" };
                yield {
                  type: "result",
                  subtype: "success",
                  result: "第一轮",
                  total_cost_usd: 0.02,
                  usage: { input_tokens: 10000, output_tokens: 0 },
                  modelUsage: firstModelUsage,
                };
                yield assistant("m2", 10000, 0); // 追加轮
                yield {
                  type: "result",
                  subtype: "success",
                  result: "第二轮",
                  total_cost_usd: 0.04,
                  usage: { input_tokens: 10000, output_tokens: 0 },
                  modelUsage: { "up-main": usage(20000, 0) }, // 完整累计:已含第一轮
                };
              })(),
            ),
            cancel: false,
          });

        for (const [label, first] of [
          ["非法模型名 1 万(未归属)", { ["x".repeat(201)]: usage(10000, 0) }],
          ["旧模型名 1 万", { "renamed-model": usage(10000, 0) }],
        ] as const) {
          it(`${label} → 修正身份后的完整累计 2 万:只收 2 万,结清;重复结算、清扫不多扣`, async () => {
            const { world, settleAgain, sweepAgain } = await corrected(first);
            expect(world.charge("r1")).toMatchObject({
              state: "settled",
              incomplete: false,
              estimatedMicro: "46200000",
              chargedMicro: "46200000",
            });
            expect(await settleAgain()).toBe("none");
            expect(await sweepAgain()).toBe(0);
            expect(world.balance("u1")).toEqual({
              available: 1000n * C - 46_200_000n,
              reserved: 0n,
            });
          });
        }
      });

      it("部分归属已修正、仍有另一项未归属且缺字段:那 1000 输出只收一次,保持暂记;重复结算、清扫不多扣", async () => {
        const { world, settleAgain, sweepAgain } = await scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield {
                type: "result",
                subtype: "success",
                result: "第一轮",
                total_cost_usd: 0.02,
                usage: { input_tokens: 10000, output_tokens: 1000 },
                modelUsage: {
                  "up-main": usage(10000, 0),
                  ["x".repeat(201)]: usage(0, 1000), // 未归属:1000 输出
                },
              };
              yield assistant("m2", 15000, 0); // 追加轮
              yield {
                type: "result",
                subtype: "error_during_execution",
                result: "追加轮出错",
                total_cost_usd: 0.04,
                modelUsage: {
                  "up-main": usage(20000, 1000), // 那 1000 输出已归到主模型
                  ["y".repeat(201)]: usage(5000, "unreadable"), // 另一项认不出、输出读不出
                },
              };
            })(),
          ),
          cancel: false,
        });
        // 主模型 2 万输入 + 1000 输出 + 未归属 5000 输入(按主模型价)= 2.5 万输入 57.75 + 1000 输出 11.55 = 69.3
        // (若把旧快照的未归属 1000 输出补回来,会再收 11.55)
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          estimatedMicro: "69300000",
          chargedMicro: "69300000",
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - 69_300_000n, reserved: 0n });
      });

      describe("新快照没提到的模型:缺失标记一并沿用", () => {
        const twoRounds = (second: Record<string, unknown>) =>
          scenario(0, {
            engine: sdk(() =>
              (async function* () {
                yield { type: "system", subtype: "init", session_id: "s" };
                yield {
                  type: "result",
                  subtype: "success",
                  result: "第一轮",
                  total_cost_usd: 0.02,
                  usage: { input_tokens: 20000, output_tokens: 0 },
                  modelUsage: {
                    "up-main": usage(10000, 0),
                    "up-sub": usage(10000, "unreadable"), // 子模型输出读不出
                  },
                };
                yield assistant("m2", 10000, 0); // 追加轮
                yield {
                  type: "result",
                  subtype: "error_during_execution",
                  result: "追加轮出错",
                  total_cost_usd: 0.03,
                  modelUsage: second,
                };
              })(),
            ),
            cancel: false,
          });

        it("子模型输出缺失 → 后续快照只含主模型:按后续累计明细收费(子模型旧数量可能已含在内,不另加),仍保持暂记;重复结算、清扫不多扣", async () => {
          const { world, settleAgain, sweepAgain } = await twoRounds({
            "up-main": usage(20000, 0),
          });
          // 主模型累计 2 万输入 = 46.2;子模型的缺失标记沿用,保持暂记
          expect(world.charge("r1")).toMatchObject({
            state: "provisional",
            incomplete: true,
            chargedMicro: "46200000",
          });
          expect(await settleAgain()).toBe("none");
          expect(await sweepAgain()).toBe(0);
          expect(world.balance("u1")).toEqual({ available: 1000n * C - 46_200_000n, reserved: 0n });
        });

        it("对照:后续快照明确补齐子模型输出 → 结清", async () => {
          const { world } = await twoRounds({
            "up-main": usage(20000, 0),
            "up-sub": usage(10000, 100),
          });
          // 3 万输入 69.3 + 100 输出 1.155 = 70.455
          expect(world.charge("r1")).toMatchObject({
            state: "settled",
            incomplete: false,
            chargedMicro: "70455000",
          });
        });
      });

      it("对照:完整的 result₂(累计 2 万输入 + 1000 输出)按它收一次,不与 result₁ 相加", async () => {
        const { world, settleAgain } = await run({ modelUsage: { "up-main": usage(20000, 1000) } });
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          chargedMicro: DUE.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(world.balance("u1")).toEqual({ available: 1000n * C - DUE, reserved: 0n });
      });
    });

    describe("计数明确给出却读不出", () => {
      const resultOnly = (usage: Record<string, unknown>) =>
        scenario(0, {
          engine: sdk(() =>
            (async function* () {
              yield { type: "system", subtype: "init", session_id: "s" };
              yield {
                type: "result",
                subtype: "success",
                result: "好的",
                total_cost_usd: 0.01,
                usage,
              };
            })(),
          ),
          cancel: false,
        });

      it("result 没有 modelUsage、usage 给出 1 万输入与 output_tokens: -1:已知输入照扣,保持暂记;重复结算不多扣", async () => {
        const { world, repo, settleAgain, sweepAgain } = await resultOnly({
          input_tokens: 10000,
          output_tokens: -1,
        });
        expect((await repo.get("r1"))?.state).toBe("success");
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          estimatedMicro: SECOND.toString(),
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });

      it("对照:有效的零、省略或为 null 的缓存项不算异常,照常结清", async () => {
        const { world } = await resultOnly({
          input_tokens: 10000,
          output_tokens: 0,
          cache_creation_input_tokens: null,
        });
        expect(world.charge("r1")).toMatchObject({
          state: "settled",
          incomplete: false,
          chargedMicro: SECOND.toString(),
        });
      });

      for (const [label, later, expected] of [
        [
          "同一条消息先报非法输出、后来那份省略输出 → 中断:省略不是新信息,缺失仍在,已知输入照扣、保持暂记",
          { input_tokens: 10000 },
          "provisional",
        ],
        [
          "对照:后来那份明确给出合法输出(0)才解除缺失,照常结清",
          { input_tokens: 10000, output_tokens: 0 },
          "settled",
        ],
      ] as const) {
        it(label, async () => {
          const msg = (usage: Record<string, unknown>) => ({
            type: "assistant",
            message: { id: "m1", model: "up-main", content: [{ type: "text", text: "x" }], usage },
          });
          const { world, settleAgain, sweepAgain } = await scenario(0, {
            makeEngine: (cancel) =>
              sdk(() =>
                (async function* () {
                  yield { type: "system", subtype: "init", session_id: "s" };
                  yield msg({ input_tokens: 10000, output_tokens: -1 });
                  yield msg(later);
                  await cancel();
                  throw new Error("aborted by user");
                })(),
              ),
          });
          expect(world.charge("r1")).toMatchObject({
            state: expected,
            incomplete: expected === "provisional",
            chargedMicro: SECOND.toString(),
          });
          expect(await settleAgain()).toBe("none");
          expect(await sweepAgain()).toBe(0);
          expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
        });
      }

      it("取消路径:按消息累计时 output_tokens 读不出 → 已知输入照扣,保持暂记;重复结算不多扣", async () => {
        const { world, settleAgain, sweepAgain } = await scenario(0, {
          makeEngine: (cancel) =>
            sdk(() =>
              (async function* () {
                yield { type: "system", subtype: "init", session_id: "s" };
                yield {
                  type: "assistant",
                  message: {
                    id: "m1",
                    model: "up-main",
                    content: [{ type: "text", text: "x" }],
                    usage: { input_tokens: 10000, output_tokens: "lots" },
                  },
                };
                await cancel();
                throw new Error("aborted by user");
              })(),
            ),
        });
        expect(world.charge("r1")).toMatchObject({
          state: "provisional",
          incomplete: true,
          chargedMicro: SECOND.toString(),
        });
        expect(await settleAgain()).toBe("none");
        expect(await sweepAgain()).toBe(0);
        expect(world.balance("u1")).toEqual({ available: 1000n * C - SECOND, reserved: 0n });
      });
    });

    it("result₁ → 追加轮 usage₂ → 抛错 → 第二轮计入、第一轮不重复", async () => {
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
      const { world, repo } = await scenario(0, { engine: sdk(q), cancel: false });
      expect((await repo.get("r1"))?.state).toBe("failed");
      const total = DUE + SECOND;
      expect(world.charge("r1")).toMatchObject({
        state: "settled",
        incomplete: false,
        estimatedMicro: total.toString(),
        chargedMicro: total.toString(),
      });
      expect(world.balance("u1").available).toBe(1000n * C - total);
    });
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

describe("引擎报过非零用量后抛错(没有最终费用):按观察到的快照处理,不按零结清", () => {
  const C = 1_000_000n;
  const H = 3600_000;
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
  // 1 万输入 = 23.1 积分
  const SNAP = {
    input: 10000,
    output: 0,
    partial: true,
    metering: {
      source: "sdk_model_usage",
      complete: true,
      partial: true,
      models: [
        {
          modelId: "up-main",
          inputTokens: 10000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    },
  };

  async function scene() {
    const ledger = new InMemoryChargeWorld();
    ledger.credit("u1", 1000n * C);
    const charging = new RunCharging({
      bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as never,
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [priced],
      transaction: ledger.transaction,
    });
    /** 库里的 runs.usage_snapshot(只在没有最终费用时写入) */
    const dbSnapshots = new Map<string, unknown>();
    const db = { down: false };
    const dbSave = async (runId: string, snap: unknown) => {
      if (db.down) throw new Error("db down");
      dbSnapshots.set(runId, structuredClone(snap));
    };
    // 编排的异步写:可以挡住
    let releaseOrch: () => void = () => {};
    const orchGate = { blocked: false };
    const orchSave = async (runId: string, snap: unknown) => {
      if (orchGate.blocked) {
        await new Promise<void>((r) => {
          releaseOrch = r;
        });
      }
      await dbSave(runId, snap);
    };
    const engine: EnginePort = {
      async run(_s, ctx) {
        ctx.onCostSnapshot?.(SNAP);
        await new Promise((r) => setTimeout(r, 0));
        throw new Error("engine crashed");
      },
    };
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
      saveUsageSnapshot: orchSave,
    });
    const clock = { endedAt: Date.now() };
    const sync = async () => {
      const r = await repo.get("r1");
      ledger.setRun("r1", {
        status: r?.state ?? "pending",
        cost: repo.recordedCosts.get("r1") ?? null,
        usageSnapshot: dbSnapshots.get("r1") ?? null,
        pricing,
        startedAt: 1,
        endedAt: clock.endedAt,
      });
    };
    const snapshotOutbox = new InMemoryCostOutbox();
    const settleCalls: boolean[] = [];
    const worker = (now: number) =>
      new RunWorker(
        repo,
        orchestrator,
        { leaseMs: 60_000, heartbeatMs: 10_000, now: () => now, costRetries: 2, costRetryMs: 1 },
        {
          saveUsageSnapshot: dbSave,
          snapshotOutbox,
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
    await ledger.transaction((store) =>
      charging.admit(store, { runId: "r1", accountId: "u1", apiKeyId: null, main: "m-main" }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    /** 模拟时间过去:把运行结束时刻往前挪 */
    const elapse = async (ms: number) => {
      clock.endedAt -= ms;
    };
    const due = 23_100_000n;
    return {
      ledger,
      charging,
      db,
      orchGate,
      release: () => releaseOrch(),
      dbSnapshots,
      snapshotOutbox,
      settleCalls,
      worker,
      elapse,
      due,
    };
  }

  it("编排的快照写入慢(worker 收尾后才放开)→ 不先按零结清;按快照暂记,24 小时后按快照结清", async () => {
    const s = await scene();
    s.orchGate.blocked = true;
    await s.worker(1000).tick();
    expect(s.settleCalls).toEqual([false]);
    expect(s.ledger.charge("r1")?.state).not.toBe("settled");
    s.release();
    await new Promise((r) => setTimeout(r, 5));
    await s.worker(1000).reclaim();
    expect(s.ledger.charge("r1")).toMatchObject({
      state: "provisional",
      incomplete: true,
      estimatedMicro: "23100000",
      chargedMicro: s.due.toString(),
    });
    await s.elapse(24 * H);
    await s.worker(1000).reclaim();
    expect(s.ledger.charge("r1")).toMatchObject({
      state: "settled",
      incomplete: false,
      estimatedMicro: "23100000",
      chargedMicro: s.due.toString(),
    });
    expect(s.ledger.deducted("u1")).toBe(s.due);
  });

  it("快照首次写库失败(编排与 worker 都没写成)→ 引擎退出 → 数据库恢复后补写 → 按快照处理,不等 24 小时免掉", async () => {
    const s = await scene();
    s.db.down = true;
    await s.worker(1000).tick();
    expect(s.settleCalls).toEqual([false]);
    expect(s.dbSnapshots.has("r1")).toBe(false);
    expect(s.snapshotOutbox.files.get("r1")).toMatchObject({ input: 10000 });
    expect(s.ledger.charge("r1")?.state).not.toBe("settled");

    s.db.down = false;
    await s.worker(1000).reclaim(); // 补写快照恢复记录 → 清扫按快照暂记
    expect(s.snapshotOutbox.files.has("r1")).toBe(false);
    expect(s.ledger.charge("r1")).toMatchObject({
      state: "provisional",
      estimatedMicro: "23100000",
      chargedMicro: s.due.toString(),
    });
    await s.elapse(24 * H);
    await s.worker(1000).reclaim();
    expect(s.ledger.charge("r1")).toMatchObject({
      state: "settled",
      chargedMicro: s.due.toString(),
    });
    expect(s.ledger.deducted("u1")).toBe(s.due);
  });

  it("一条用量都没观察到就抛错:仍按规则直接按 0 结清", async () => {
    const ledger = new InMemoryChargeWorld();
    ledger.credit("u1", 1000n * C);
    const charging = new RunCharging({
      bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as never,
      reserveTargetOf: async () => 300n * C,
      pricedModels: async () => [priced],
      transaction: ledger.transaction,
    });
    const engine: EnginePort = {
      async run() {
        throw new Error("engine crashed");
      },
    };
    const { repo, orchestrator } = await setup(engine);
    const calls: boolean[] = [];
    await ledger.transaction((store) =>
      charging.admit(store, { runId: "r1", accountId: "u1", apiKeyId: null, main: "m-main" }),
    );
    await repo.createWithPrompt("r1", "s1", "go");
    await new RunWorker(
      repo,
      orchestrator,
      { leaseMs: 60_000, now: () => 1000 },
      {
        saveUsageSnapshot: async () => {},
        settleCharge: async (id, opts) => {
          calls.push(opts.final);
          const r = await repo.get("r1");
          ledger.setRun("r1", { status: r?.state ?? "pending", cost: null, pricing, startedAt: 1 });
          return charging.settle(id, opts);
        },
      },
    ).tick();
    expect(calls).toEqual([true]);
    expect(ledger.charge("r1")).toMatchObject({ state: "settled", chargedMicro: "0" });
  });
});
