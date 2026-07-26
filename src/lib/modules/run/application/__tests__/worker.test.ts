// Worker 测试:用内存 repo + 假引擎,时钟由测试控制,确定性地断言租约与崩溃恢复。

import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAssistantRepo } from "@/lib/modules/assistant/adapters/in-memory-assistant-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

/** 内存 repo + prompt 存储,凑齐 worker 需要的 RunRepo & RunPayloadSource。 */
class TestRepo extends InMemoryRunRepo {
  private prompts = new Map<string, string>();
  async createWithPrompt(id: string, sessionId: string, prompt: string) {
    await this.create({ id, sessionId });
    this.prompts.set(id, prompt);
  }
  async getPrompt(id: string): Promise<string | null> {
    return this.prompts.get(id) ?? null;
  }
}

class FakeEngine implements EnginePort {
  seenPrompts: string[] = [];
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
    await this.onRun?.();
    return this.result;
  }
}

async function setup(engine: EnginePort, now: () => number = () => 1000) {
  const repo = new TestRepo();
  const sessions = new InMemorySessionRepo();
  const assistants = new InMemoryAssistantRepo([
    { id: "a1", name: "助手", config: { systemPrompt: "p", model: "sonnet" } },
  ]);
  await sessions.create({ id: "s1", assistantId: "a1", workspaceDir: "/ws/s1" });

  const orchestrator = new RunOrchestrator({
    sessions,
    assistants,
    engine,
    bus: new InMemoryBus(),
    platformCredentials: { baseUrl: "b", key: "k" },
  });
  const worker = new RunWorker(repo, orchestrator, {
    leaseMs: 1000,
    heartbeatMs: 10_000,
    now,
  });
  return { repo, worker, orchestrator };
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
  it("回收租约过期的孤儿任务,让其它 worker 能接手", async () => {
    // worker A 在 t=1000 认领,租约到 2000 后崩溃
    let clock = 1000;
    const { repo, worker } = await setup(new FakeEngine(), () => clock);
    await repo.createWithPrompt("r1", "s1", "go");
    await repo.claimNext(1000, 1000);

    // 时间推到租约之后
    clock = 5000;
    expect(await worker.reclaim()).toBe(1);
    expect((await repo.get("r1"))?.state).toBe("pending");

    // 存活的 worker 接手并跑完
    expect(await worker.tick()).toBe(true);
    expect((await repo.get("r1"))?.state).toBe("success");
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
});
