// 多 worker 并发压力测试(对真实 MySQL)。
//
// 为什么必须单独测:队列的乐观锁认领、租约续期、孤儿回收,设计目的就是多 worker 场景,
// 而单 worker 的契约测试永远碰不到"同一个 run 被两个 worker 同时认领"这类问题 ——
// 它只在并发下暴露,而且一旦发生就是【同一个任务被执行两次】,对 agent 来说
// 可能意味着重复扣费、重复下单、重复发邮件。
//
// 未配置 OWA_TEST_DATABASE_URL 时跳过并明确说明。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import { InMemoryAssistantRepo } from "@/lib/modules/assistant/adapters/in-memory-assistant-repo";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

if (!TEST_DB_URL) {
  console.warn("[skip] 并发压力测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向专用测试库");
} else {
  const dbName = databaseNameOf(TEST_DB_URL);
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(db);

  /** 记录每个 run 被执行了几次 —— 并发正确性的核心断言。 */
  const executions = new Map<string, number>();
  /** 记录每个任务是被哪个 worker 执行的 —— 用来证明并发【真的发生了】。 */
  const executedBy = new Map<string, string>();

  class RecordingEngine implements EnginePort {
    constructor(
      private readonly workerId: string,
      private readonly delayMs = 5,
    ) {}
    async run(
      _spec: AgentSpec,
      ctx: RunContext,
      _onEvent: (e: AgentEvent) => void,
      _signal: AbortSignal,
    ): Promise<RunResult> {
      // prompt 里带着 run 标识,据此统计执行次数
      const key = ctx.prompt;
      executions.set(key, (executions.get(key) ?? 0) + 1);
      executedBy.set(key, this.workerId);
      // 留出真实的执行窗口,让并发有机会撞车
      await new Promise((r) => setTimeout(r, this.delayMs));
      return { status: "success", summary: "ok" };
    }
  }

  const sessions = new InMemorySessionRepo();
  const assistants = new InMemoryAssistantRepo([
    {
      id: "a1",
      ownerId: "u1",
      name: "并发测试助手",
      config: { systemPrompt: "p", model: "sonnet" },
    },
  ]);

  function makeWorker(workerId: string, engineDelayMs = 5) {
    const orchestrator = new RunOrchestrator({
      sessions,
      assistants,
      engine: new RecordingEngine(workerId, engineDelayMs),
      bus: new InMemoryBus(),
      platformCredentials: { baseUrl: "b", key: "k" },
    });
    return new RunWorker(repo, orchestrator, {
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      idleMs: 5,
    });
  }

  beforeEach(async () => {
    await repo._truncate(dbName);
    executions.clear();
    executedBy.clear();
  });

  afterAll(async () => {
    await repo._truncate(dbName);
    await pool.end();
  });

  describe("多 worker 并发", { timeout: 60_000 }, () => {
    it("N 个 worker 抢同一队列:每个任务恰好执行一次,不重不漏", async () => {
      const SESSION = "s-conc";
      await sessions.create({ id: SESSION, assistantId: "a1", workspaceDir: "/ws" });

      const TASKS = 24;
      const ids: string[] = [];
      for (let i = 0; i < TASKS; i++) {
        const id = randomUUID().replace(/-/g, "").slice(0, 24);
        ids.push(id);
        await repo.create({ id, sessionId: SESSION, prompt: `task-${i}` });
      }

      // 4 个 worker 同时抢
      const workers = ["w1", "w2", "w3", "w4"].map((id) => makeWorker(id));
      for (const w of workers) w.start();

      // 等队列排空
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const states = await Promise.all(ids.map((id) => repo.get(id)));
        if (states.every((s) => s?.state === "success")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const w of workers) w.stop();

      // 全部完成
      const finalStates = await Promise.all(ids.map((id) => repo.get(id)));
      expect(finalStates.filter((s) => s?.state === "success")).toHaveLength(TASKS);

      // 【核心】没有任何任务被执行两次 —— 重复执行意味着重复扣费/重复下单
      const duplicated = [...executions.entries()].filter(([, n]) => n > 1);
      expect(duplicated).toEqual([]);
      // 也没有漏掉的
      expect(executions.size).toBe(TASKS);

      // 【并发真的发生了】否则这个测试只是"单 worker 顺序跑完",证明不了任何并发正确性
      const participatingWorkers = new Set(executedBy.values());
      expect(participatingWorkers.size).toBeGreaterThan(1);
    });

    it("并发认领同一个任务:只有一个 worker 拿到", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-x", prompt: "only-once" });

      // 8 路同时认领
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => repo.claimNext(30_000, Date.now())),
      );
      expect(claims.filter((c) => c !== null)).toHaveLength(1);
    });

    it("worker 崩溃后任务被其它 worker 接手,且最终只成功一次", async () => {
      const SESSION = "s-crash";
      await sessions.create({ id: SESSION, assistantId: "a1", workspaceDir: "/ws" });
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: SESSION, prompt: "crash-task" });

      // 模拟 worker A 认领后崩溃:占住租约却再也不续期
      const now = Date.now();
      await repo.claimNext(1000, now);
      expect((await repo.get(id))?.state).toBe("running");

      // 租约过期后由存活的 worker 回收并接手
      const w = makeWorker("survivor");
      expect(await repo.reclaimOrphans(now + 5000)).toBe(1);
      expect(await w.tick()).toBe(true);

      expect((await repo.get(id))?.state).toBe("success");
      expect(executions.get("crash-task")).toBe(1);
    });

    // 栅栏令牌(fencing token)。
    //
    // 上面那条"worker 崩溃后被接手"只覆盖了崩溃进程【不再写库】的情形。真实的坏情况是
    // 进程还活着:DB 抖动导致续租连续失败,租约悄悄过期被回收,而它自己毫不知情 ——
    // 继续跑、跑完、然后把结果写进去,覆盖掉接手者已经写好的正确结果。
    // 光靠租约时间挡不住,必须让写入本身带上"我是当前持有者"的凭证。
    it("【双执行回归】僵尸 worker 拿旧令牌写不进结果,接手者的结果不被覆盖", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-fence", prompt: "fence-task" });

      const now = Date.now();
      const zombie = await repo.claimNext(1000, now); // A 认领,随后失联
      expect(zombie?.fence).toBeTruthy();

      const taker = await repo.claimNext(30_000, now + 5000); // 租约过期,B 接手
      expect(taker?.id).toBe(id);
      expect(taker?.fence).not.toBe(zombie?.fence);

      // A 的续租此刻必须返回 false —— 这是 worker 侧中止本轮的唯一信号
      expect(await repo.touch(id, now + 60_000, zombie?.fence)).toBe(false);
      // B 的续租正常
      expect(await repo.touch(id, now + 60_000, taker?.fence)).toBe(true);

      // B 先写完
      await repo.saveResult(id, { structured: { from: "taker" } }, taker?.fence);
      expect(await repo.complete(id, "success", taker?.fence)).toBe(true);

      // A 姗姗来迟,试图写自己的结果 —— 两处都必须是空操作
      await repo.saveResult(id, { structured: { from: "zombie" } }, zombie?.fence);
      expect(await repo.complete(id, "failed", zombie?.fence)).toBe(false);

      const final = await repo.getResult(id);
      expect(final?.status).toBe("success");
      expect(final?.structured).toEqual({ from: "taker" });
    });

    it("终态不可被任何后续写入翻转 —— 包括不带令牌的直接调用", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-final", prompt: "t" });
      const c = await repo.claimNext(30_000, Date.now());
      expect(await repo.complete(id, "success", c?.fence)).toBe(true);
      expect(await repo.complete(id, "failed")).toBe(false);
      expect((await repo.get(id))?.state).toBe("success");
    });

    it("saveResult 只写传进来的字段 —— 补记 error 不该抹掉已落库的结果", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-patch", prompt: "t" });
      await repo.saveResult(id, { structured: { ok: 1 }, cost: { usd: 2 } });
      await repo.saveResult(id, { error: { kind: "worker_error" } });
      const r = await repo.getResult(id);
      expect(r?.structured).toEqual({ ok: 1 }); // 曾经这里会变成 null
      expect(r?.cost).toEqual({ usd: 2 });
      expect(r?.error).toMatchObject({ kind: "worker_error" });
    });

    it("租约内的任务不会被其它 worker 抢走(执行中不被打断)", async () => {
      const SESSION = "s-lease";
      await sessions.create({ id: SESSION, assistantId: "a1", workspaceDir: "/ws" });
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: SESSION, prompt: "long-task" });

      const now = Date.now();
      const claimed = await repo.claimNext(30_000, now);
      expect(claimed?.id).toBe(id);

      // 租约期内,别的 worker 一律拿不到
      const others = await Promise.all(
        Array.from({ length: 5 }, () => repo.claimNext(30_000, now + 1000)),
      );
      expect(others.every((o) => o === null)).toBe(true);
    });

    it("持续入队时多 worker 也不重复执行(边跑边加)", async () => {
      const SESSION = "s-stream";
      await sessions.create({ id: SESSION, assistantId: "a1", workspaceDir: "/ws" });

      const workers = ["s1", "s2", "s3"].map((id) => makeWorker(id, 2));
      for (const w of workers) w.start();

      const ids: string[] = [];
      // 分批入队,模拟真实的持续负载
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 5; i++) {
          const id = randomUUID().replace(/-/g, "").slice(0, 24);
          ids.push(id);
          await repo.create({ id, sessionId: SESSION, prompt: `stream-${batch}-${i}` });
        }
        await new Promise((r) => setTimeout(r, 30));
      }

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const states = await Promise.all(ids.map((id) => repo.get(id)));
        if (states.every((s) => s?.state === "success")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const w of workers) w.stop();

      expect([...executions.values()].filter((n) => n > 1)).toEqual([]);
      expect(executions.size).toBe(ids.length);
      // 同样要确认多个 worker 都参与了
      expect(new Set(executedBy.values()).size).toBeGreaterThan(1);
    });
  });
}
