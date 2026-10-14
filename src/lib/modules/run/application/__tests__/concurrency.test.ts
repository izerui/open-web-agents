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
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
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
  // 【必须留一个跳过的 suite】否则整个文件没有任何测试,vitest 会报
  // "No test suite found" —— 一个只是缺依赖的文件显示成红色失败,
  // 而真正的失败就淹没在里面了。跳过要长得像跳过。
  describe.skip("多 worker 并发压力测试(未配置 OWA_TEST_DATABASE_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  const dbName = databaseNameOf(TEST_DB_URL);
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(db);

  /** 记录每个 run 被执行了几次 —— 并发正确性的核心断言。 */
  const executions = new Map<string, number>();
  /** 记录每个任务是被哪个 worker 执行的。 */
  const executedBy = new Map<string, string>();
  /** 正在执行的运行:任务 → worker。用来度量真实的并行度与同会话重叠。 */
  const inFlight = new Map<string, { workerId: string; sessionId: string }>();
  /** 执行期间同时在跑的不同 worker 数的峰值 —— 证明并发【真的发生了】。 */
  let peakWorkers = 0;
  /** 同一会话的两个运行在执行期间重叠 —— 会话内必须串行(同一工作目录、同一份 SDK 会话)。 */
  const sessionOverlaps: string[] = [];
  /**
   * 汇合点:运行先等到至少两个不同的 worker 同时在执行,再往下走(最多等 5 秒)。
   * 原先只断言"多个 worker 都执行过",而且全部任务都在同一个会话里 —— 会话内串行,
   * 实际从没有两个运行同时在执行,"恰好执行一次"也就没在真正的并行下检验过。
   * 现在任务分散在多个会话,并要求不同 worker 确实同时在执行:只要多 worker 并行可行就必然达成,
   * 达不成说明认领本身有问题,而不是靠执行窗口碰运气。
   */
  const newRendezvous = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  let rendezvous = newRendezvous();
  const distinctWorkersInFlight = () => new Set([...inFlight.values()].map((r) => r.workerId)).size;

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
      if ([...inFlight.values()].some((r) => r.sessionId === ctx.sessionId)) {
        sessionOverlaps.push(`${ctx.sessionId}:${key}`);
      }
      inFlight.set(key, { workerId: this.workerId, sessionId: ctx.sessionId });
      peakWorkers = Math.max(peakWorkers, distinctWorkersInFlight());
      if (peakWorkers >= 2) rendezvous.resolve();
      try {
        await Promise.race([rendezvous.promise, new Promise((r) => setTimeout(r, 5_000))]);
        // 留出真实的执行窗口,让并发有机会撞车
        await new Promise((r) => setTimeout(r, this.delayMs));
        return { status: "success", summary: "ok" };
      } finally {
        inFlight.delete(key);
      }
    }
  }

  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    {
      id: "a1",
      ownerId: "u1",
      name: "并发测试智能体",
      config: { systemPrompt: "p", model: "sonnet" },
    },
  ]);

  function makeWorker(workerId: string, engineDelayMs = 5) {
    const orchestrator = new RunOrchestrator({
      sessions,
      agents,
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
    inFlight.clear();
    peakWorkers = 0;
    sessionOverlaps.length = 0;
    rendezvous = newRendezvous();
  });

  afterAll(async () => {
    await repo._truncate(dbName);
    await pool.end();
  });

  describe("多 worker 并发", { timeout: 60_000 }, () => {
    it("N 个 worker 抢同一队列:每个任务恰好执行一次,不重不漏", async () => {
      // 任务分散在多个会话里:同一会话内是串行的,只有跨会话才会真的并行执行。
      // 会话数(6)多于单个 worker 的槽位数(默认 4),一个 worker 吃不下全部 —— 别的 worker 必然参与。
      // 按块分配(连续 4 个任务同一会话):最早的几个任务同属一个会话,认领必须跳过忙碌的会话
      // 去拿别的会话的任务 —— 会话互斥一旦失效,同会话的任务会被同时认领,重叠必然出现
      const SESSIONS = ["s-conc-0", "s-conc-1", "s-conc-2", "s-conc-3", "s-conc-4", "s-conc-5"];
      for (const sid of SESSIONS) {
        await sessions.create({ id: sid, agentId: "a1", workspaceDir: `/ws/${sid}` });
      }

      const TASKS = 24;
      const ids: string[] = [];
      for (let i = 0; i < TASKS; i++) {
        const id = randomUUID().replace(/-/g, "").slice(0, 24);
        ids.push(id);
        await repo.create({
          id,
          sessionId: SESSIONS[Math.floor(i / 4)] as string,
          prompt: `task-${i}`,
        });
      }

      // 4 个 worker 同时抢
      // 执行时长要明显长于一次认领(一次数据库事务),运行之间才会真的重叠;
      // 只停 5ms 时绝大多数时刻只有一个运行在执行,会话互斥失效也撞不出来
      const workers = ["w1", "w2", "w3", "w4"].map((id) => makeWorker(id, 100));
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

      // 【并发真的发生了】不同 worker 同时在执行 —— 否则这个测试只是"顺序跑完",证明不了并发正确性
      expect(peakWorkers).toBeGreaterThan(1);
      // 并行只发生在会话之间:同一会话的运行从不重叠
      expect(sessionOverlaps).toEqual([]);
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

    it("【至多一次】worker 崩溃后任务判失败,存活的 worker 不会重跑", async () => {
      const SESSION = "s-crash";
      await sessions.create({ id: SESSION, agentId: "a1", workspaceDir: "/ws" });
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: SESSION, prompt: "crash-task" });

      // 模拟 worker A 认领后崩溃:占住租约却再也不续期
      const now = Date.now();
      await repo.claimNext(1000, now);
      expect((await repo.get(id))?.state).toBe("running");

      // 租约过期后由存活的 worker 回收:判失败,而不是从头再跑一遍
      const w = makeWorker("survivor");
      expect((await repo.reclaimOrphans(now + 5000)).map((r) => r.id)).toEqual([id]);
      expect(await w.tick()).toBe(false);

      const final = await repo.getResult(id);
      expect(final?.status).toBe("failed");
      expect((final?.error as { kind?: string } | null)?.kind).toBe("worker_lost");
      expect(executions.get("crash-task")).toBeUndefined();
    });

    // 栅栏令牌(fencing token)。
    //
    // 真实的坏情况是进程还活着:DB 抖动导致续租连续失败,租约悄悄过期被回收,
    // 而它自己毫不知情 —— 继续跑、跑完、然后把结果写进去。
    // 光靠租约时间挡不住,必须让写入本身带上"我是当前持有者"的凭证。
    it("【双执行回归】被判为孤儿后,僵尸 worker 拿旧令牌写不进结果", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-fence", prompt: "fence-task" });

      const now = Date.now();
      const zombie = await repo.claimNext(1000, now); // A 认领,随后失联
      expect(zombie?.fence).toBeTruthy();
      expect((await repo.reclaimOrphans(now + 5000)).map((r) => r.id)).toEqual([id]);

      // A 的续租此刻必须返回 false —— 这是 worker 侧中止本轮的唯一信号
      expect(await repo.touch(id, now + 60_000, zombie?.fence)).toBe(false);

      // A 姗姗来迟,试图写自己的结果 —— 两处都必须是空操作
      await repo.saveResult(id, { structured: { from: "zombie" } }, zombie?.fence);
      expect(await repo.complete(id, "success", zombie?.fence)).toBe(false);

      const final = await repo.getResult(id);
      expect(final?.status).toBe("failed");
      expect(final?.structured).toBeNull();
    });

    it("终态登记回调发件箱,投递器认领后别人拿不到", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-hook", prompt: "t" });
      const c = await repo.claimNext(30_000, Date.now());
      expect(await repo.complete(id, "success", c?.fence)).toBe(true);

      const now = Date.now();
      const [a, b] = await Promise.all([
        repo.claimWebhook(now, 60_000),
        repo.claimWebhook(now, 60_000),
      ]);
      const claimed = [a, b].filter((x) => x !== null);
      expect(claimed.map((x) => x?.runId)).toEqual([id]);
      expect(claimed[0]?.attempts).toBe(1);

      // 投递中租约未过期:拿不到
      expect(await repo.claimWebhook(now + 1000, 60_000)).toBeNull();
      // 安排重试:到期前拿不到,到期后能拿到,attempts 累加
      expect(await repo.markWebhook(id, claimed[0]?.lease ?? "", "pending", now + 10_000)).toBe(
        true,
      );
      expect(await repo.claimWebhook(now + 5_000, 60_000)).toBeNull();
      expect((await repo.claimWebhook(now + 10_000, 60_000))?.attempts).toBe(2);
      // 投递中的进程崩了:租约过期后可被重新认领
      const third = await repo.claimWebhook(now + 80_000, 60_000);
      expect(third?.attempts).toBe(3);
      expect(await repo.markWebhook(id, third?.lease ?? "", "delivered")).toBe(true);
      expect(await repo.claimWebhook(now + 999_999, 60_000)).toBeNull();
    });

    it("被取消的运行补记花费:不需要令牌,且不覆盖已结算的数据", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-cost", prompt: "t" });
      await repo.claimNext(30_000, Date.now());
      await repo.cancel(id);
      await repo.recordCost(id, { input: 10, output: 2, partial: true });
      await repo.recordCost(id, { input: 99, output: 99 });
      expect((await repo.getResult(id))?.cost).toEqual({ input: 10, output: 2, partial: true });
    });

    it("取消与孤儿回收同样登记回调 —— 等回调的系统不能永远等下去", async () => {
      const a = randomUUID().replace(/-/g, "").slice(0, 24);
      const b = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id: a, sessionId: "s-c1", prompt: "t" });
      await repo.create({ id: b, sessionId: "s-c2", prompt: "t" });
      await repo.cancel(a);
      const now = Date.now();
      await repo.claimNext(1000, now);
      await repo.reclaimOrphans(now + 5000);

      const got = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const j = await repo.claimWebhook(now + 6000, 60_000);
        if (j) got.add(j.runId);
      }
      expect(got).toEqual(new Set([a, b]));
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
      await sessions.create({ id: SESSION, agentId: "a1", workspaceDir: "/ws" });
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
      // 同上:分散到多个会话才有真正的并行执行;按块分配,连续 4 个任务同一会话
      const SESSIONS = ["s-stream-0", "s-stream-1", "s-stream-2", "s-stream-3", "s-stream-4"];
      for (const sid of SESSIONS) {
        await sessions.create({ id: sid, agentId: "a1", workspaceDir: `/ws/${sid}` });
      }

      const workers = ["s1", "s2", "s3"].map((id) => makeWorker(id, 60));
      for (const w of workers) w.start();

      const ids: string[] = [];
      // 分批入队,模拟真实的持续负载
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 5; i++) {
          const id = randomUUID().replace(/-/g, "").slice(0, 24);
          ids.push(id);
          await repo.create({
            id,
            sessionId: SESSIONS[Math.floor((batch * 5 + i) / 4)] as string,
            prompt: `stream-${batch}-${i}`,
          });
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
      // 同样要确认不同 worker 同时在执行,且同一会话从不重叠
      expect(peakWorkers).toBeGreaterThan(1);
      expect(sessionOverlaps).toEqual([]);
    });
  });
}
