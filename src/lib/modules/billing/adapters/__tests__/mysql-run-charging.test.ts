// 运行计费的 MySQL 行为:冻结与运行记录同事务、幂等键并发、Key 月度上限并发、模式快照与清扫。
import { randomUUID } from "node:crypto";
import { type Db, createDb } from "@/lib/db/client";
import { runCharges, runs, users } from "@/lib/db/schema";
import { chargedCreate } from "@/lib/design-transaction";
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { MysqlApiKeyRepo } from "@/lib/modules/identity/adapters/mysql-api-key-repo";
import { MysqlUserRepo } from "@/lib/modules/identity/adapters/mysql-user-repo";
import type { RunModelBinding } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import { RunEnqueuer } from "@/lib/modules/run/application/enqueue";
import { DuplicateIdempotencyKey } from "@/lib/modules/run/ports";
import type { RunPricing } from "@/lib/shared";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ChargeRejected, RunCharging } from "../../application/run-charging";
import type { BillingMode } from "../../domain/run-charge";
import { MysqlBillingRepo } from "../mysql-billing-repo";
import { MysqlRunChargeQuery } from "../mysql-run-charge-query";
import { MysqlRunChargeStore, SWEEP_GRACE_MS } from "../mysql-run-charge-store";

const url = process.env.OWA_TEST_DATABASE_URL;
const C = 1_000_000n;

if (!url) {
  describe.skip("run charging: MySQL requires OWA_TEST_DATABASE_URL", () => {
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
  const binding = { pricing, main: { capabilityId: "m-main" } } as unknown as RunModelBinding;
  // 2 万输入 + 1 千输出 = 57.75 积分
  const COST = {
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
  };
  const EXPECTED = 57_750_000n;

  function setup(mode: BillingMode, reserve = 300n * C, now?: () => number) {
    const state = { mode };
    const charging = new RunCharging({
      mode: async () => state.mode,
      bind: async () => binding,
      reserveTargetOf: async () => reserve,
      pricedModels: async () => [model],
      now,
      transaction: (fn) =>
        db.transaction((tx) => fn(new MysqlRunChargeStore(tx as unknown as Db)), {
          isolationLevel: "read committed",
        }),
    });
    const charged = chargedCreate(db, charging);
    const enqueue = (
      accountId: string,
      opts: {
        runId?: string;
        apiKeyId?: string | null;
        idempotencyKey?: string;
        failAfterAdmit?: boolean;
      } = {},
    ) => {
      const runId = opts.runId ?? randomUUID();
      return charged(async ({ runs: repo, admit }) => {
        const p = await admit({
          runId,
          accountId,
          apiKeyId: opts.apiKeyId ?? null,
          main: "m-main",
        });
        if (opts.failAfterAdmit) throw new Error("runs.create 失败");
        await repo.create({
          id: runId,
          sessionId: "s-billing",
          prompt: "hi",
          pricing: p,
          idempotencyKey: opts.idempotencyKey,
        });
        return runId;
      });
    };
    return { state, charging, enqueue };
  }

  const wallet = new MysqlBillingRepo(db);
  const fund = async (credits: bigint) => {
    const accountId = randomUUID();
    if (credits > 0n) {
      await wallet.credit({
        accountId,
        amountMicroCredits: (credits * C).toString(),
        idempotencyKey: randomUUID(),
        actorId: "test",
        reason: "测试",
      });
    }
    return accountId;
  };
  const charge = async (runId: string) =>
    (await db.select().from(runCharges).where(eq(runCharges.runId, runId)))[0] ?? null;
  const finish = (
    runId: string,
    status = "success",
    cost: unknown = COST,
    endedAt = new Date(),
    startedAt: Date | null = new Date(),
  ) => db.update(runs).set({ status, cost, endedAt, startedAt }).where(eq(runs.id, runId));

  /** 走真实入队(与路由同一路径):会话归属 accountId,可带 API Key 与幂等键 */
  const enqueuerFor = (charging: RunCharging, accountId: string, apiKeyId?: string) =>
    new RunEnqueuer({
      runs: { create: async () => Promise.reject(new Error("应走计费事务")) },
      charged: chargedCreate(db, charging),
      sessions: {
        get: async (id) =>
          ({
            id,
            agentId: "a",
            workspaceDir: "/w",
            ownerId: accountId,
            billingUserId: accountId,
            callerApiKeyId: apiKeyId,
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          }) as never,
      },
      agents: { get: async () => ({ id: "a", ownerId: accountId, name: "a" }) as never },
      releases: {
        at: async () =>
          ({ config: { systemPrompt: "p", model: "m-main" }, version: null }) as never,
      },
    });

  describe("MySQL 运行计费", () => {
    it("冻结、run_charges 与运行记录同事务:运行插入失败全部回滚", async () => {
      const { enqueue } = setup("live");
      const acct = await fund(1000n);
      const runId = randomUUID();
      await expect(enqueue(acct, { runId, failAfterAdmit: true })).rejects.toThrow(/失败/);
      expect(await charge(runId)).toBeNull();
      expect(await wallet.balance(acct)).toMatchObject({
        availableMicroCredits: (1000n * C).toString(),
        reservedMicroCredits: "0",
      });
      expect((await db.select().from(runs).where(eq(runs.id, runId))).length).toBe(0);
    });

    it("同一幂等键并发两次:只有一个运行、一份冻结", async () => {
      const { enqueue } = setup("live");
      const acct = await fund(1000n);
      const key = `idem-${randomUUID()}`;
      const out = await Promise.allSettled([
        enqueue(acct, { idempotencyKey: key }),
        enqueue(acct, { idempotencyKey: key }),
      ]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const failed = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(DuplicateIdempotencyKey);
      expect((await wallet.balance(acct)).reservedMicroCredits).toBe((300n * C).toString());
    });

    it("同一 Key 并发两次,月度上限只够一次:只有一次受理", async () => {
      const { enqueue } = setup("live");
      const acct = await fund(10_000n);
      const keys = new MysqlApiKeyRepo(db);
      const keyId = randomUUID().slice(0, 24);
      await keys.create({ id: keyId, ownerId: acct, hashedKey: randomUUID() });
      await keys.setMonthlyLimit(keyId, (300n * C).toString());
      const out = await Promise.allSettled([
        enqueue(acct, { apiKeyId: keyId }),
        enqueue(acct, { apiKeyId: keyId }),
      ]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const failed = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect((failed.reason as ChargeRejected).code).toBe("key_limit_exceeded");
      const used = await new MysqlRunChargeQuery(db).monthUsageByKey(
        acct,
        "live",
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      );
      expect(used.get(keyId)).toBe(300n * C);
    });

    it("正式:余额不足拒绝;够则冻结,结束按实际扣、其余退回", async () => {
      const { enqueue, charging } = setup("live");
      const poor = await fund(10n);
      await expect(enqueue(poor)).rejects.toMatchObject({ code: "insufficient_balance" });
      const acct = await fund(1000n);
      const runId = await enqueue(acct);
      expect((await wallet.balance(acct)).reservedMicroCredits).toBe((300n * C).toString());
      await finish(runId);
      expect(await charging.settle(runId)).toBe("settled");
      expect(await wallet.balance(acct)).toMatchObject({
        availableMicroCredits: (1000n * C - EXPECTED).toString(),
        reservedMicroCredits: "0",
      });
      expect(await charge(runId)).toMatchObject({
        chargedMicro: EXPECTED.toString(),
        estimatedMicro: EXPECTED.toString(),
        state: "settled",
      });
    });

    it("试算:余额为 0 也受理并记本应拒绝;非零售价运行结束余额不变、实扣 0", async () => {
      const { enqueue, charging } = setup("trial");
      const broke = await fund(0n);
      const r0 = await enqueue(broke);
      expect(await charge(r0)).toMatchObject({ wouldReject: "insufficient_balance" });
      const acct = await fund(1000n);
      const runId = await enqueue(acct);
      await finish(runId);
      await charging.settle(runId);
      expect(await wallet.balance(acct)).toMatchObject({
        availableMicroCredits: (1000n * C).toString(),
        reservedMicroCredits: "0",
      });
      expect(await charge(runId)).toMatchObject({
        chargedMicro: "0",
        estimatedMicro: EXPECTED.toString(),
      });
    });

    it("模式按受理时快照:试算受理后切正式仍扣 0;正式受理后切试算仍照扣(含清扫补结算)", async () => {
      const t = setup("trial");
      const a = await fund(1000n);
      const trialRun = await t.enqueue(a);
      t.state.mode = "live";
      await finish(trialRun);
      await t.charging.settle(trialRun);
      expect((await charge(trialRun))?.chargedMicro).toBe("0");
      expect((await wallet.balance(a)).availableMicroCredits).toBe((1000n * C).toString());

      const l = setup("live");
      const b = await fund(1000n);
      const liveRun = await l.enqueue(b);
      l.state.mode = "trial";
      // 不经 worker(如取消接口直接改状态后才补记花费):清扫补结算
      await finish(liveRun, "cancelled");
      let swept = 0;
      for (let i = 0; i < 20 && (await charge(liveRun))?.state !== "settled"; i++) {
        swept += await l.charging.sweep(200);
      }
      expect(swept).toBeGreaterThan(0);
      expect((await charge(liveRun))?.chargedMicro).toBe(EXPECTED.toString());
      expect((await wallet.balance(b)).availableMicroCredits).toBe(
        (1000n * C - EXPECTED).toString(),
      );
    });

    it("清扫:已结束但没写花费的运行,宽限期内不处理;从没开始执行的过了宽限期按 0 结清", async () => {
      const { enqueue, charging } = setup("live");
      const acct = await fund(1000n);
      const runId = await enqueue(acct);
      await finish(runId, "cancelled", null, new Date(), null);
      const store = (fn: (s: MysqlRunChargeStore) => Promise<string[]>) =>
        db.transaction((tx) => fn(new MysqlRunChargeStore(tx as unknown as Db)));
      expect(await store((s) => s.openOfFinishedRuns(1000))).not.toContain(runId);
      await finish(runId, "cancelled", null, new Date(Date.now() - SWEEP_GRACE_MS - 1000), null);
      expect(await store((s) => s.openOfFinishedRuns(1000))).toContain(runId);
      await charging.settle(runId);
      expect(await wallet.balance(acct)).toMatchObject({
        availableMicroCredits: (1000n * C).toString(),
        reservedMicroCredits: "0",
      });
      expect(await charge(runId)).toMatchObject({
        chargedMicro: "0",
        state: "settled",
        incomplete: 0,
      });
    });

    for (const mode of ["live", "trial"] as const) {
      it(`${mode}:取消 → 过宽限期清扫(暂记、标不完整)→ worker 补记非零花费 → 补齐且不重复`, async () => {
        const { enqueue, charging } = setup(mode);
        const acct = await fund(1000n);
        const runId = await enqueue(acct);
        // 跑过(已认领)、被取消,花费还没补记,且已过宽限期
        await finish(runId, "cancelled", null, new Date(Date.now() - SWEEP_GRACE_MS - 1000));
        for (let i = 0; i < 20 && (await charge(runId))?.state === "open"; i++) {
          await charging.sweep(200);
        }
        expect(await charge(runId)).toMatchObject({
          state: "provisional",
          incomplete: 1,
          chargedMicro: "0",
        });
        expect(await wallet.balance(acct)).toMatchObject({
          availableMicroCredits: (1000n * C).toString(),
          reservedMicroCredits: "0",
        });

        // worker 收尾:补记真实花费,随后结算(final)
        await db.update(runs).set({ cost: COST }).where(eq(runs.id, runId));
        expect(await charging.settle(runId, { final: true })).toBe("settled");
        const charged = mode === "live" ? EXPECTED : 0n;
        expect(await charge(runId)).toMatchObject({
          state: "settled",
          incomplete: 0,
          estimatedMicro: EXPECTED.toString(),
          chargedMicro: charged.toString(),
        });
        // 重复结算、再清扫都不再扣
        expect(await charging.settle(runId, { final: true })).toBe("none");
        await charging.sweep(200);
        expect(await wallet.balance(acct)).toMatchObject({
          availableMicroCredits: (1000n * C - charged).toString(),
          reservedMicroCredits: "0",
        });
      });
    }

    it("暂记且花费没变的不会被清扫反复捞出;花费变了才补结算(指纹在库里比)", async () => {
      const { enqueue, charging } = setup("live");
      const acct = await fund(1000n);
      const runId = await enqueue(acct);
      const partial = (input: number, complete: boolean) => ({
        input,
        output: 0,
        partial: true,
        metering: {
          source: "sdk_model_usage",
          complete,
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
      await finish(runId, "cancelled", partial(10000, false));
      expect(await charging.settle(runId, { final: true })).toBe("provisional");
      expect(await charge(runId)).toMatchObject({ state: "provisional", chargedMicro: "23100000" });
      const open = () =>
        db.transaction((tx) =>
          new MysqlRunChargeStore(tx as unknown as Db).openOfFinishedRuns(10_000),
        );
      expect(await open()).not.toContain(runId);

      await db
        .update(runs)
        .set({ cost: partial(20000, true) })
        .where(eq(runs.id, runId));
      expect(await open()).toContain(runId);
      for (let i = 0; i < 20 && (await charge(runId))?.state !== "settled"; i++) {
        await charging.sweep(200);
      }
      expect(await charge(runId)).toMatchObject({
        state: "settled",
        chargedMicro: "46200000",
        incomplete: 0,
      });
      expect((await wallet.balance(acct)).availableMicroCredits).toBe(
        (1000n * C - 46_200_000n).toString(),
      );
      expect(await open()).not.toContain(runId);
    });

    it("已扣非零 → 明细缺失不退 → 补齐并确认减少后只退差额一次;净扣、钱包、流水(扣款 − 退还)一致", async () => {
      const { enqueue, charging } = setup("live");
      const acct = await fund(1000n);
      const runId = await enqueue(acct);
      const cost = (input: number, complete: boolean) => ({
        input,
        output: 0,
        partial: true,
        metering: {
          source: "sdk_model_usage",
          complete,
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
      // 流水里的净扣 = 结算(settle)扣款合计 − 退还(refund)合计
      const ledgerSum = async (kind: string) => {
        const [rows] = (await pool.query(
          "SELECT COALESCE(SUM(amount_micro_credits), 0) AS s FROM billing_ledger WHERE account_id = ? AND kind = ?",
          [acct, kind],
        )) as unknown as [{ s: string }[]];
        return BigInt(String(rows[0]?.s ?? "0").split(".")[0] || "0");
      };
      const check = async (charged: bigint, state: string, refunded = 0n) => {
        expect(await charge(runId)).toMatchObject({
          chargedMicro: charged.toString(),
          refundedMicro: refunded ? refunded.toString() : null,
          state,
        });
        expect((await ledgerSum("settle")) - (await ledgerSum("refund"))).toBe(charged);
        expect(await ledgerSum("refund")).toBe(refunded);
        expect((await wallet.balance(acct)).availableMicroCredits).toBe(
          (1000n * C - charged).toString(),
        );
      };
      const settleUntilStable = async () => {
        for (let i = 0; i < 20; i++) {
          const before = JSON.stringify(await charge(runId));
          await charging.sweep(500);
          if (JSON.stringify(await charge(runId)) === before) return;
        }
      };

      await finish(runId, "cancelled", cost(40000, false));
      await charging.settle(runId, { final: true });
      await check(92_400_000n, "provisional");

      await db
        .update(runs)
        .set({ cost: { input: 30000, output: 0, partial: true } }) // 没有按模型的计量
        .where(eq(runs.id, runId));
      await settleUntilStable();
      await check(92_400_000n, "provisional"); // 算不出来不等于应扣减少:不退
      expect(await charge(runId)).toMatchObject({ estimatedMicro: "0", incomplete: 1 });

      await db
        .update(runs)
        .set({ cost: cost(30000, true) })
        .where(eq(runs.id, runId));
      await settleUntilStable();
      await check(69_300_000n, "settled", 23_100_000n); // 确认减少:只退差额 23.1

      await charging.settle(runId, { final: true });
      await settleUntilStable();
      await check(69_300_000n, "settled", 23_100_000n);
    });

    it("升级:旧规则留下的多扣暂记 —— 迁移 0051 后清扫重新结算:完整计价的退差额一次,不完整的不退、也不反复进入清扫", async () => {
      const { enqueue, charging } = setup("live");
      const acct = await fund(1000n);
      const meter = (input: number, complete: boolean) => ({
        input,
        output: 0,
        partial: true,
        metering: {
          source: "sdk_model_usage",
          complete,
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
      const open = () =>
        db.transaction((tx) =>
          new MysqlRunChargeStore(tx as unknown as Db).openOfFinishedRuns(10_000),
        );
      const ledgerSum = async (kind: string) => {
        const [rows] = (await pool.query(
          "SELECT COALESCE(SUM(amount_micro_credits), 0) AS s FROM billing_ledger WHERE account_id = ? AND kind = ?",
          [acct, kind],
        )) as unknown as [{ s: string }[]];
        return BigInt(String(rows[0]?.s ?? "0").split(".")[0] || "0");
      };

      // 造出旧规则停住的样子:先按不完整的 4 万输入扣了 92.4,之后费用改成 3 万输入(69.3),
      // 旧规则不退款,记录停在暂记,应扣写成 69.3,指纹与当前费用一致
      const legacy = async (complete: boolean) => {
        const runId = await enqueue(acct);
        await finish(runId, "cancelled", meter(40000, false));
        await charging.settle(runId, { final: true });
        await db
          .update(runs)
          .set({ cost: meter(30000, complete) })
          .where(eq(runs.id, runId));
        await pool.query(
          `UPDATE run_charges rc JOIN runs r ON r.id = rc.run_id
             SET rc.estimated_micro = 69300000, rc.settled_cost_digest = SHA2(CAST(r.cost AS CHAR), 256)
           WHERE rc.run_id = ?`,
          [runId],
        );
        return runId;
      };
      const full = await legacy(true);
      const partial = await legacy(false);
      for (const id of [full, partial]) {
        expect(await charge(id)).toMatchObject({ state: "provisional", chargedMicro: "92400000" });
      }
      // 迁移前:问题能复现 —— 清扫不选,直接结算也提前返回
      expect(await open()).not.toContain(full);
      expect(await charging.settle(full, { final: true })).toBe("none");

      // 执行 0051 迁移文件里的语句(原样读取)
      const fs = await import("node:fs/promises");
      const migration = await fs.readFile("drizzle/0051_reevaluate_overpaid.sql", "utf8");
      for (const stmt of migration.split("--> statement-breakpoint")) {
        const sqlText = stmt
          .split("\n")
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n")
          .trim();
        if (sqlText) await pool.query(sqlText);
      }
      const selected = await open();
      expect(selected).toContain(full);
      expect(selected).toContain(partial);

      for (let i = 0; i < 20 && (await open()).some((id) => id === full || id === partial); i++) {
        await charging.sweep(500);
      }
      // 完整计价的:退差额 23.1,一次
      expect(await charge(full)).toMatchObject({
        state: "settled",
        chargedMicro: "69300000",
        refundedMicro: "23100000",
      });
      // 不完整的:不退,继续暂记;指纹写回,不再进入清扫
      expect(await charge(partial)).toMatchObject({
        state: "provisional",
        chargedMicro: "92400000",
        refundedMicro: null,
      });
      expect(await open()).not.toContain(partial);
      expect(await open()).not.toContain(full);

      await charging.sweep(500);
      await charging.settle(full, { final: true });
      expect(await ledgerSum("refund")).toBe(23_100_000n);
      expect((await ledgerSum("settle")) - (await ledgerSum("refund"))).toBe(
        69_300_000n + 92_400_000n,
      );
      expect((await wallet.balance(acct)).availableMicroCredits).toBe(
        (1000n * C - 69_300_000n - 92_400_000n).toString(),
      );
    });

    it("欠款补扣:超过冻结额 → 余额不足留欠 → 充值 → 清扫补扣一次 → 重复执行不再扣(核对钱包、流水、实扣、欠额)", async () => {
      const { enqueue, charging } = setup("live", 30n * C);
      const acct = await fund(50n);
      const runId = await enqueue(acct);
      const ledgerCharged = async () => {
        const [rows] = (await pool.query(
          "SELECT COALESCE(SUM(amount_micro_credits), 0) AS s FROM billing_ledger WHERE account_id = ? AND kind = 'settle'",
          [acct],
        )) as unknown as [{ s: string }[]];
        return BigInt(String(rows[0]?.s ?? "0").split(".")[0] || "0");
      };
      const check = async (
        charged: bigint,
        owed: string | null,
        state: string,
        available: bigint,
      ) => {
        expect(await charge(runId)).toMatchObject({
          chargedMicro: charged.toString(),
          owedMicro: owed,
          state,
        });
        expect(await ledgerCharged()).toBe(charged);
        expect(await wallet.balance(acct)).toMatchObject({
          availableMicroCredits: available.toString(),
          reservedMicroCredits: "0",
        });
      };
      const open = () =>
        db.transaction((tx) =>
          new MysqlRunChargeStore(tx as unknown as Db).openOfFinishedRuns(10_000),
        );

      await finish(runId); // 实际 57.75,冻结只有 30
      await charging.settle(runId, { final: true });
      await check(30n * C, "27750000", "provisional", 20n * C);
      // 余额不够:清扫不捞它
      expect(await open()).not.toContain(runId);
      await charging.settle(runId, { final: true });
      await check(30n * C, "27750000", "provisional", 20n * C);

      await wallet.credit({
        accountId: acct,
        amountMicroCredits: (100n * C).toString(),
        idempotencyKey: randomUUID(),
        actorId: "test",
        reason: "充值",
      });
      expect(await open()).toContain(runId);
      for (let i = 0; i < 20 && (await charge(runId))?.state !== "settled"; i++) {
        await charging.sweep(500);
      }
      await check(57_750_000n, null, "settled", 150n * C - 57_750_000n);
      expect(await charge(runId)).toMatchObject({ incomplete: 0 });

      expect(await open()).not.toContain(runId);
      await charging.settle(runId, { final: true });
      await charging.sweep(500);
      await check(57_750_000n, null, "settled", 150n * C - 57_750_000n);
    });

    for (const scope of ["account", "key"] as const) {
      it(`月度上限计入欠额(${scope === "account" ? "账号" : "Key"}):超限留欠 → 再发起被拒;充值补扣后已用不变`, async () => {
        const { charging } = setup("live", 30n * C);
        const acct = await fund(50n);
        const limit = (50n * C).toString();
        let keyId: string | undefined;
        if (scope === "account") {
          await db.insert(users).values({
            id: acct,
            email: `limit-${acct}@example.test`,
            passwordHash: "x",
            role: "user",
            monthlyLimitMicroCredits: limit,
          } as never);
        } else {
          const keys = new MysqlApiKeyRepo(db);
          keyId = randomUUID().slice(0, 24);
          await keys.create({ id: keyId, ownerId: acct, hashedKey: randomUUID() });
          await keys.setMonthlyLimit(keyId, limit);
        }
        const enqueuer = enqueuerFor(charging, acct, keyId);
        const go = () => enqueuer.enqueue({ runId: randomUUID(), sessionId: "s", prompt: "hi" });
        const since = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
        const query = new MysqlRunChargeQuery(db);
        const shown = async () =>
          scope === "account"
            ? (await query.monthUsageByAccount("live", since)).get(acct)
            : (await query.monthUsageByKey(acct, "live", since)).get(keyId ?? "");
        const code = scope === "account" ? "account_limit_exceeded" : "key_limit_exceeded";

        const first = await go();
        await finish(first.id); // 实际 57.75,冻结 30,余额只剩 20
        await charging.settle(first.id, { final: true });
        expect(await charge(first.id)).toMatchObject({
          chargedMicro: "30000000",
          owedMicro: "27750000",
        });
        expect(await shown()).toBe(57_750_000n);
        await expect(go()).rejects.toMatchObject({ code });
        expect((await wallet.balance(acct)).reservedMicroCredits).toBe("0");

        await wallet.credit({
          accountId: acct,
          amountMicroCredits: (100n * C).toString(),
          idempotencyKey: randomUUID(),
          actorId: "test",
          reason: "充值",
        });
        for (let i = 0; i < 20 && (await charge(first.id))?.state !== "settled"; i++) {
          await charging.sweep(500);
        }
        expect(await charge(first.id)).toMatchObject({ chargedMicro: "57750000", owedMicro: null });
        expect(await shown()).toBe(57_750_000n);
        await expect(go()).rejects.toMatchObject({ code });
      });
    }

    for (const scope of ["account", "key"] as const) {
      it(`跨月(${scope === "account" ? "账号" : "Key"}):月底受理 → 下月连续追加冻结 → 记在受理月份、受它的上限约束,展示同口径`, async () => {
        const JAN = Date.UTC(2026, 0, 31, 23, 30);
        const FEB = Date.UTC(2026, 1, 1, 0, 30);
        const clock = { t: JAN };
        const { charging } = setup("live", 30n * C, () => clock.t);
        const acct = await fund(1000n);
        let keyId: string | undefined;
        if (scope === "account") {
          await db.insert(users).values({
            id: acct,
            email: `xmonth-${acct}@example.test`,
            passwordHash: "x",
            role: "user",
            monthlyLimitMicroCredits: (50n * C).toString(),
          } as never);
        } else {
          const keys = new MysqlApiKeyRepo(db);
          keyId = randomUUID().slice(0, 24);
          await keys.create({ id: keyId, ownerId: acct, hashedKey: randomUUID() });
          await keys.setMonthlyLimit(keyId, (50n * C).toString());
        }
        const query = new MysqlRunChargeQuery(db);
        const shown = async (at: number) => {
          const since = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), 1);
          return scope === "account"
            ? ((await query.monthUsageByAccount("live", since)).get(acct) ?? 0n)
            : ((await query.monthUsageByKey(acct, "live", since)).get(keyId ?? "") ?? 0n);
        };
        const enqueuer = enqueuerFor(charging, acct, keyId);

        const r1 = await enqueuer.enqueue({ runId: randomUUID(), sessionId: "s", prompt: "hi" });
        clock.t = FEB;
        expect(await charging.topUp(r1.id)).toBe(true); // 1 月剩 20
        expect(await charging.topUp(r1.id)).toBe(false);
        expect(await charging.topUp(r1.id)).toBe(false);
        expect(await charge(r1.id)).toMatchObject({ reservedMicro: (50n * C).toString() });
        expect((await wallet.balance(acct)).reservedMicroCredits).toBe((50n * C).toString());
        expect(await shown(JAN)).toBe(50n * C);
        expect(await shown(FEB)).toBe(0n);

        const r2 = await enqueuer.enqueue({ runId: randomUUID(), sessionId: "s", prompt: "hi" });
        expect(await charge(r2.id)).toMatchObject({ reservedMicro: (30n * C).toString() });
        expect(await shown(FEB)).toBe(30n * C);
        expect(await shown(JAN)).toBe(50n * C);
      });
    }

    it("同一幂等键并发两次、余额只够冻结一次:后到的拿到原任务(重复键),而不是 402", async () => {
      const { charging } = setup("live", 50n * C);
      const acct = await fund(60n); // 冻 50 后只剩 10,低于 20 的门槛
      const enqueuer = enqueuerFor(charging, acct);
      const key = `idem-once-${randomUUID()}`;
      const req = () =>
        enqueuer.enqueue({
          runId: randomUUID(),
          sessionId: "s",
          prompt: "hi",
          idempotencyKey: key,
        });
      const out = await Promise.allSettled([req(), req()]);
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const failed = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(DuplicateIdempotencyKey);
      expect((await wallet.balance(acct)).reservedMicroCredits).toBe((50n * C).toString());
    });

    it("同一幂等键并发两次、Key 月度上限只够一次:同样拿到原任务", async () => {
      const { charging } = setup("live", 50n * C);
      const acct = await fund(10_000n);
      const keys = new MysqlApiKeyRepo(db);
      const keyId = randomUUID().slice(0, 24);
      await keys.create({ id: keyId, ownerId: acct, hashedKey: randomUUID() });
      await keys.setMonthlyLimit(keyId, (50n * C).toString());
      const enqueuer = enqueuerFor(charging, acct, keyId);
      const key = `idem-key-${randomUUID()}`;
      const req = () =>
        enqueuer.enqueue({
          runId: randomUUID(),
          sessionId: "s",
          prompt: "hi",
          idempotencyKey: key,
        });
      const out = await Promise.allSettled([req(), req()]);
      const failed = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(failed.reason).toBeInstanceOf(DuplicateIdempotencyKey);
    });

    it("升级遗留:配置过美元上限、未按积分设置的账号 —— 正式拒绝、试算放行;管理员设置后按新上限", async () => {
      const userRepo = new MysqlUserRepo(db);
      const acct = await fund(1000n);
      // 模拟升级前就存在的账号:只有旧美元上限,新积分上限列为 NULL(0047 迁移后的样子)
      await db.insert(users).values({
        id: acct,
        email: `legacy-${acct}@example.test`,
        passwordHash: "x",
        role: "user",
        monthlyQuotaMicroUsd: 5_000_000,
      } as never);
      expect((await userRepo.get(acct))?.legacyMonthlyLimitMicroUsd).toBe(5_000_000);

      await expect(setup("live").enqueue(acct)).rejects.toMatchObject({
        code: "account_limit_pending",
      });
      const trialRun = await setup("trial").enqueue(acct);
      expect(await charge(trialRun)).toMatchObject({ wouldReject: "account_limit_pending" });

      await userRepo.adminUpdate(acct, { monthlyLimitMicroCredits: (500n * C).toString() });
      const after = await userRepo.get(acct);
      expect(after?.legacyMonthlyLimitMicroUsd).toBeUndefined();
      expect(after?.monthlyLimitMicroCredits).toBe((500n * C).toString());
      await expect(setup("live").enqueue(acct)).resolves.toBeTruthy();

      // 明确设为不限,同样算处理完毕
      const other = await fund(1000n);
      await db.insert(users).values({
        id: other,
        email: `legacy-${other}@example.test`,
        passwordHash: "x",
        role: "user",
        monthlyQuotaMicroUsd: 0,
      } as never);
      await userRepo.adminUpdate(other, { monthlyLimitMicroCredits: null });
      expect((await userRepo.get(other))?.legacyMonthlyLimitMicroUsd).toBeUndefined();
      await expect(setup("live").enqueue(other)).resolves.toBeTruthy();
    });
  });
}
