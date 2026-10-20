// 恢复补写与原 worker 收尾并发(真实 MySQL 仓储、真实计费与钱包):
// 引擎交回费用并落恢复记录 → 另一轮恢复先写库、删记录 → 原编排抛错 → 原 worker 收尾。
// 核对:库里的费用不被收尾覆盖成 NULL,最终只扣一次。
import { randomUUID } from "node:crypto";
import { type Db, createDb } from "@/lib/db/client";
import { runCharges, runs } from "@/lib/db/schema";
import type { EnginePort } from "@/lib/modules/agent-engine/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { MysqlBillingRepo } from "@/lib/modules/billing/adapters/mysql-billing-repo";
import { MysqlRunChargeStore } from "@/lib/modules/billing/adapters/mysql-run-charge-store";
import { RunCharging } from "@/lib/modules/billing/application/run-charging";
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import type { RunModelBinding } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import { InMemoryCostOutbox } from "@/lib/modules/run/adapters/fs-cost-outbox";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { EngineRunFailed, RunOrchestrator } from "@/lib/modules/run/application/orchestrator";
import { RunWorker } from "@/lib/modules/run/application/worker";
import type { Run } from "@/lib/modules/run/ports";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { RunPricing } from "@/lib/shared";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.OWA_TEST_DATABASE_URL;
const C = 1_000_000n;

if (!url) {
  describe.skip("worker recovery race: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  const { db, pool } = createDb(url);
  afterAll(() => pool.end());

  const model: Capability = {
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
  const COST = {
    input: 20000,
    output: 1000,
    pricing,
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
  };

  const wallet = new MysqlBillingRepo(db);
  const charging = new RunCharging({
    mode: async () => "live",
    bind: async () => ({ pricing, main: { capabilityId: "m-main" } }) as unknown as RunModelBinding,
    reserveTargetOf: async () => 300n * C,
    pricedModels: async () => [model],
    transaction: (fn) =>
      db.transaction((tx) => fn(new MysqlRunChargeStore(tx as unknown as Db)), {
        isolationLevel: "read committed",
      }),
  });

  /** 一个待执行的运行:账户有 1000 积分,已冻结,运行记录带锁定价目 */
  async function pendingRun() {
    const accountId = randomUUID();
    await wallet.credit({
      accountId,
      amountMicroCredits: (1000n * C).toString(),
      idempotencyKey: randomUUID(),
      actorId: "test",
      reason: "测试",
    });
    const runId = randomUUID().replace(/-/g, "").slice(0, 24);
    await db.transaction(async (tx) => {
      const p = await charging.admit(new MysqlRunChargeStore(tx as unknown as Db), {
        runId,
        accountId,
        apiKeyId: null,
        main: "m-main",
      });
      await new MysqlRunRepo(tx as unknown as Db).create({
        id: runId,
        sessionId: `s-${runId}`,
        prompt: "go",
        pricing: p,
      });
    });
    return { runId, accountId };
  }

  /** 真实仓储;只把"认领"限定成本用例的运行(共享测试库里还有别的待执行运行) */
  function repoFor(runId: string) {
    const real = new MysqlRunRepo(db);
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "claimNext") {
          return async (leaseMs: number, now: number): Promise<Run | null> => {
            const fence = randomUUID();
            const [res] = (await pool.query(
              "UPDATE runs SET status = 'running', lease_until = ?, lease_owner = ?, started_at = COALESCE(started_at, NOW()), attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
              [now + leaseMs, fence, runId],
            )) as unknown as [{ affectedRows: number }];
            if (res.affectedRows === 0) return null;
            return {
              id: runId,
              sessionId: `s-${runId}`,
              state: "running",
              leaseUntil: now + leaseMs,
              fence,
            };
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as MysqlRunRepo;
  }

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => {
      open = r;
    });
    return { open, opened };
  }

  const ledgerSum = async (accountId: string, kind: string) => {
    const [rows] = (await pool.query(
      "SELECT COALESCE(SUM(amount_micro_credits), 0) AS s FROM billing_ledger WHERE account_id = ? AND kind = ?",
      [accountId, kind],
    )) as unknown as [{ s: string }[]];
    return BigInt(String(rows[0]?.s ?? "0").split(".")[0] || "0");
  };

  for (const variant of ["错误带着费用(真实编排的行为)", "普通错误、不带费用"] as const) {
    it(`引擎交回费用并落盘 → 另一轮恢复先写库删记录 → 原编排抛错(${variant}) → 原 worker 收尾:费用仍在库里,只扣一次`, async () => {
      const { runId, accountId } = await pendingRun();
      const outbox = new InMemoryCostOutbox();
      const saved = gate();
      const proceed = gate();
      // 编排:引擎交回费用、落恢复记录,然后停住;放行后出错
      const orchestrator = {
        execute: async (cmd: { runId?: string }) => {
          await outbox.save(cmd.runId ?? "", COST);
          saved.open();
          await proceed.opened;
          if (variant === "普通错误、不带费用") throw new Error("orchestrator crashed");
          throw new EngineRunFailed(new Error("orchestrator crashed"), COST as never);
        },
      } as unknown as RunOrchestrator;
      const hooks = {
        costOutbox: outbox,
        settleCharge: (id: string, opts: { final: boolean }) => charging.settle(id, opts),
        sweepCharges: () => charging.sweep(500),
      };
      const original = new RunWorker(repoFor(runId), orchestrator, { leaseMs: 60_000 }, hooks);
      const recovery = new RunWorker(repoFor(runId), orchestrator, { leaseMs: 60_000 }, hooks);

      const tick = original.tick();
      await saved.opened;
      // 另一轮恢复(回收循环里的补写)抢先:写库、删记录;运行还在执行,结算返回 pending
      expect(await recovery.flushPendingCosts()).toBe(1);
      expect(outbox.files.has(runId)).toBe(false);
      const [mid] = await db.select({ cost: runs.cost }).from(runs).where(eq(runs.id, runId));
      expect(mid?.cost).toBeTruthy();

      proceed.open();
      await tick;

      const [row] = await db
        .select({ status: runs.status, cost: runs.cost })
        .from(runs)
        .where(eq(runs.id, runId));
      expect(row?.status).toBe("failed");
      expect(row?.cost).toMatchObject({ input: 20000, output: 1000 });
      const [charge] = await db.select().from(runCharges).where(eq(runCharges.runId, runId));
      expect(charge).toMatchObject({
        state: "settled",
        chargedMicro: DUE.toString(),
        incomplete: 0,
      });

      // 重复补写、清扫、结算:不再扣
      await recovery.flushPendingCosts();
      await charging.settle(runId, { final: true });
      expect(await ledgerSum(accountId, "settle")).toBe(DUE);
      expect(await ledgerSum(accountId, "refund")).toBe(0n);
      expect((await wallet.balance(accountId)).availableMicroCredits).toBe(
        (1000n * C - DUE).toString(),
      );
    });
  }

  describe("快照序号:旧快照不能覆盖新快照", () => {
    const snap = (input: number) => ({
      input,
      output: 0,
      partial: true,
      metering: {
        source: "sdk_model_usage",
        complete: true,
        partial: true,
        models: [
          {
            modelId: "up-main",
            inputTokens: input,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    });
    // A = 1 万输入(23.1 积分),B = 2 万输入(46.2 积分)
    const B_DUE = 46_200_000n;

    for (const mode of ["live", "trial"] as const) {
      it(`${mode}:编排写 A 卡住、期间收到 B → 引擎抛错、worker 写成 B → A 晚到被拒 → 编排重写 B 失败:库里始终是 B,24 小时后按 B 结清`, async () => {
        const modeCharging = new RunCharging({
          mode: async () => mode,
          bind: async () =>
            ({ pricing, main: { capabilityId: "m-main" } }) as unknown as RunModelBinding,
          reserveTargetOf: async () => 300n * C,
          pricedModels: async () => [model],
          transaction: (fn) =>
            db.transaction((tx) => fn(new MysqlRunChargeStore(tx as unknown as Db)), {
              isolationLevel: "read committed",
            }),
        });
        const accountId = randomUUID();
        await wallet.credit({
          accountId,
          amountMicroCredits: (1000n * C).toString(),
          idempotencyKey: randomUUID(),
          actorId: "test",
          reason: "测试",
        });
        const runId = randomUUID().replace(/-/g, "").slice(0, 24);
        await db.transaction(async (tx) => {
          const p = await modeCharging.admit(new MysqlRunChargeStore(tx as unknown as Db), {
            runId,
            accountId,
            apiKeyId: null,
            main: "m-main",
          });
          await new MysqlRunRepo(tx as unknown as Db).create({
            id: runId,
            sessionId: `s-${runId}`,
            prompt: "go",
            pricing: p,
          });
        });
        const repo = new MysqlRunRepo(db);
        const stored = async () => {
          const [row] = await db
            .select({ s: runs.usageSnapshot })
            .from(runs)
            .where(eq(runs.id, runId));
          return row?.s as { input: number; seq: number } | null;
        };

        // 编排的异步写:第一笔(A)卡在门口;之后的重写失败
        let orchCalls = 0;
        let releaseA!: () => void;
        const aHeld = new Promise<void>((r) => {
          releaseA = r;
        });
        const aDone = { done: false };
        const orchSave = async (id: string, cost: unknown) => {
          orchCalls++;
          if (orchCalls === 1) {
            await aHeld;
            await repo.saveUsageSnapshot(id, cost);
            aDone.done = true;
            return;
          }
          throw new Error("db down");
        };
        const sessions = new InMemorySessionRepo();
        await sessions.create({ id: `s-${runId}`, agentId: "a1", workspaceDir: "/ws/x" });
        const engine: EnginePort = {
          async run(_s, ctx) {
            ctx.onCostSnapshot?.(snap(10000)); // A
            await new Promise((r) => setTimeout(r, 0));
            ctx.onCostSnapshot?.(snap(20000)); // B
            throw new Error("engine crashed");
          },
        };
        const binding = {
          providerId: "p",
          baseUrl: "https://gw",
          main: { ref: "m-main", modelId: "up-main", capabilityId: "m-main" },
          subagents: {},
          slots: { fable: "up-main", opus: "up-main", sonnet: "up-main", haiku: "up-main" },
          pricing,
        } as unknown as RunModelBinding;
        const orchestrator = new RunOrchestrator({
          sessions,
          agents: new InMemoryAgentRepo([
            { id: "a1", ownerId: "u1", name: "a", config: { systemPrompt: "p", model: "m-main" } },
          ]),
          engine,
          bus: new InMemoryBus(),
          resolveModels: async () => ({
            binding,
            credentials: { baseUrl: "https://gw", key: "k" },
          }),
          saveUsageSnapshot: orchSave,
        });
        const snapshotOutbox = new InMemoryCostOutbox();
        const worker = new RunWorker(
          repoFor(runId),
          orchestrator,
          { leaseMs: 60_000 },
          {
            saveUsageSnapshot: (id, sn) => repo.saveUsageSnapshot(id, sn),
            snapshotOutbox,
            settleCharge: (id, opts) => modeCharging.settle(id, opts),
            sweepCharges: () => modeCharging.sweep(500),
          },
        );

        await worker.tick();
        // worker 把 B 写成了,恢复记录已删
        expect(await stored()).toMatchObject({ input: 20000, seq: 2 });
        expect(snapshotOutbox.files.has(runId)).toBe(false);

        releaseA(); // A 晚到:序号更小,被拒
        for (let i = 0; i < 100 && !aDone.done; i++) await new Promise((r) => setTimeout(r, 5));
        for (let i = 0; i < 100 && orchCalls < 2; i++) await new Promise((r) => setTimeout(r, 5));
        expect(orchCalls).toBe(2); // 编排随后重写 B,失败
        expect(await stored()).toMatchObject({ input: 20000, seq: 2 });

        // 清扫按 B 暂记;过 24 小时按 B 结清
        for (let i = 0; i < 20; i++) await modeCharging.sweep(500);
        const due = mode === "live" ? B_DUE : 0n;
        let [c] = await db.select().from(runCharges).where(eq(runCharges.runId, runId));
        expect(c).toMatchObject({
          state: "provisional",
          estimatedMicro: B_DUE.toString(),
          chargedMicro: due.toString(),
        });
        await pool.query("UPDATE runs SET ended_at = ended_at - INTERVAL 25 HOUR WHERE id = ?", [
          runId,
        ]);
        for (let i = 0; i < 20; i++) await modeCharging.sweep(500);
        [c] = await db.select().from(runCharges).where(eq(runCharges.runId, runId));
        expect(c).toMatchObject({
          state: "settled",
          incomplete: 0,
          estimatedMicro: B_DUE.toString(),
          chargedMicro: due.toString(),
        });
        expect(await stored()).toMatchObject({ input: 20000, seq: 2 });
        expect((await wallet.balance(accountId)).availableMicroCredits).toBe(
          (1000n * C - due).toString(),
        );
      });
    }
  });
}
