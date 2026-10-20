import type { Db } from "@/lib/db/client";
import { apiKeys, billingWallets, runCharges, runs, users } from "@/lib/db/schema";
import { type PinnedPricing, type RunPricing, isUnavailableAtAdmission } from "@/lib/shared";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { BillingMode, HoldRejection, HoldSlice } from "../domain/run-charge";
import { billingKey, emptyWallet } from "../domain/wallet";
import { BillingError, type WalletBalance } from "../ports";
import type { AccountLimit, RunCharge, RunChargeStore, RunForSettle } from "../run-charge-ports";
import { MysqlBillingRepo } from "./mysql-billing-repo";

type Row = typeof runCharges.$inferSelect;

function chargeOf(r: Row): RunCharge {
  return {
    runId: r.runId,
    accountId: r.accountId,
    apiKeyId: r.apiKeyId,
    mode: r.mode as BillingMode,
    reservedMicro: r.reservedMicro,
    holds: (r.reservationIds as HoldSlice[]) ?? [],
    estimatedMicro: r.estimatedMicro,
    chargedMicro: r.chargedMicro,
    owedMicro: r.owedMicro,
    refundedMicro: r.refundedMicro ?? null,
    state: r.state as RunCharge["state"],
    wouldReject: (r.wouldReject as HoldRejection | null) ?? null,
    incomplete: r.incomplete === 1,
    settledCostDigest: r.settledCostDigest ?? null,
    createdAt: r.createdAt.getTime(),
    settledAt: r.settledAt?.getTime() ?? null,
  };
}

const TERMINAL = ["success", "failed", "cancelled"];
/** 运行结束后还没写花费的,等这么久再按"没有花费"结算 */
export const SWEEP_GRACE_MS = 2 * 60_000;

/**
 * 月度占用(受理时的额度检查与各处展示共用这一个口径):
 * 冻结中的按冻结额;正式模式结算过的按"实扣 + 已确认欠额" —— 欠额是已经确认花掉、只是还没扣到的,
 * 不算进去的话,已知超限的账号与 Key 还能继续发起;充值补扣只是欠额转成实扣,合计不变。
 * 试算按预计消耗。
 */
export function monthUsedSql(mode: BillingMode) {
  const settled =
    mode === "live"
      ? sql`COALESCE(${runCharges.chargedMicro}, 0) + COALESCE(${runCharges.owedMicro}, 0)`
      : sql`COALESCE(${runCharges.estimatedMicro}, 0)`;
  return sql<
    string | null
  >`SUM(CASE WHEN ${runCharges.state} = 'open' THEN ${runCharges.reservedMicro} ELSE ${settled} END)`;
}

/** 运行花费的指纹:结算与清扫用同一个表达式,保证可比 */
// 来源也算进指纹:快照与最终费用内容可以完全相同(结算消息之后的快照就是最终费用),
// 不区分的话,按快照暂记之后补写同一份最终费用,指纹不变,清扫不选、结算提前返回,记录永远停在不完整。
// 最终费用的指纹保持原样(已有记录不受影响),快照加前缀
const COST_DIGEST = sql<string | null>`CASE
  WHEN ${runs.cost} IS NOT NULL THEN SHA2(CAST(${runs.cost} AS CHAR), 256)
  WHEN ${runs.usageSnapshot} IS NOT NULL THEN SHA2(CONCAT('snapshot:', CAST(${runs.usageSnapshot} AS CHAR)), 256)
  END`;

/** 必须用外层事务的连接构造(`new MysqlRunChargeStore(tx as Db)`):行锁持有到外层事务结束 */
export class MysqlRunChargeStore implements RunChargeStore {
  private readonly wallet: MysqlBillingRepo;

  constructor(private readonly db: Db) {
    // 钱包仓库在外层事务里开的"事务"是保存点,与本事务同进退
    this.wallet = new MysqlBillingRepo(db);
  }

  async lockAccount(accountId: string): Promise<WalletBalance> {
    const accountKey = billingKey(accountId);
    await this.db
      .insert(billingWallets)
      .values({ accountKey, ...emptyWallet(accountId) })
      .onDuplicateKeyUpdate({ set: { accountKey } });
    const [row] = await this.db
      .select()
      .from(billingWallets)
      .where(eq(billingWallets.accountKey, accountKey))
      .limit(1);
    if (!row) throw new BillingError(500, "wallet_missing", "账户初始化失败");
    return {
      accountId: row.accountId,
      availableMicroCredits: row.availableMicroCredits,
      reservedMicroCredits: row.reservedMicroCredits,
    };
  }

  async monthUsage(filter: {
    accountId?: string;
    apiKeyId?: string;
    mode: BillingMode;
    since: number;
    until: number;
  }): Promise<bigint> {
    const [row] = await this.db
      .select({ used: monthUsedSql(filter.mode) })
      .from(runCharges)
      .where(
        and(
          eq(runCharges.mode, filter.mode),
          gte(runCharges.createdAt, new Date(filter.since)),
          lt(runCharges.createdAt, new Date(filter.until)),
          filter.accountId ? eq(runCharges.accountId, filter.accountId) : undefined,
          filter.apiKeyId ? eq(runCharges.apiKeyId, filter.apiKeyId) : undefined,
        ),
      );
    return BigInt(String(row?.used ?? "0").split(".")[0] || "0");
  }

  async openTrialReserved(accountId: string): Promise<bigint> {
    const [row] = await this.db
      .select({ v: sql<string | null>`SUM(${runCharges.reservedMicro})` })
      .from(runCharges)
      .where(
        and(
          eq(runCharges.accountId, accountId),
          eq(runCharges.mode, "trial"),
          eq(runCharges.state, "open"),
        ),
      );
    return BigInt(String(row?.v ?? "0").split(".")[0] || "0");
  }

  async accountLimit(accountId: string): Promise<AccountLimit> {
    const [row] = await this.db
      .select({ v: users.monthlyLimitMicroCredits, legacy: users.monthlyQuotaMicroUsd })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    if (row?.v !== null && row?.v !== undefined) return { limit: BigInt(row.v), pending: false };
    // 升级前配置的美元上限:不擅自换算成积分,等管理员按积分重新设置
    return { limit: null, pending: row?.legacy !== null && row?.legacy !== undefined };
  }

  async keyLimit(apiKeyId: string): Promise<bigint | null> {
    const [row] = await this.db
      .select({ v: apiKeys.monthlyLimitMicroCredits })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);
    return row?.v === null || row?.v === undefined ? null : BigInt(row.v);
  }

  async reserveWallet(accountId: string, reservationId: string, amount: bigint): Promise<void> {
    await this.wallet.reserve({ accountId, reservationId, amountMicroCredits: amount.toString() });
  }

  async settleWallet(accountId: string, reservationId: string, charged: bigint): Promise<void> {
    await this.wallet.settle({ accountId, reservationId, chargedMicroCredits: charged.toString() });
  }

  async refundWallet(accountId: string, refundId: string, amount: bigint): Promise<void> {
    await this.wallet.refund({ accountId, refundId, amountMicroCredits: amount.toString() });
  }

  async insert(c: RunCharge): Promise<void> {
    await this.db.insert(runCharges).values({
      runId: c.runId,
      accountId: c.accountId,
      apiKeyId: c.apiKeyId,
      mode: c.mode,
      reservedMicro: c.reservedMicro,
      reservationIds: c.holds,
      estimatedMicro: c.estimatedMicro,
      chargedMicro: c.chargedMicro,
      owedMicro: c.owedMicro,
      refundedMicro: c.refundedMicro,
      state: c.state,
      wouldReject: c.wouldReject,
      incomplete: c.incomplete ? 1 : 0,
      settledCostDigest: c.settledCostDigest,
      createdAt: new Date(c.createdAt),
      settledAt: c.settledAt === null ? null : new Date(c.settledAt),
    });
  }

  async get(runId: string, forUpdate = false): Promise<RunCharge | null> {
    if (forUpdate) {
      await this.db.execute(sql`SELECT run_id FROM run_charges WHERE run_id = ${runId} FOR UPDATE`);
    }
    const [row] = await this.db
      .select()
      .from(runCharges)
      .where(eq(runCharges.runId, runId))
      .limit(1);
    return row ? chargeOf(row) : null;
  }

  async update(runId: string, patch: Partial<Omit<RunCharge, "runId">>): Promise<void> {
    const set: Partial<typeof runCharges.$inferInsert> = {};
    if (patch.reservedMicro !== undefined) set.reservedMicro = patch.reservedMicro;
    if (patch.holds !== undefined) set.reservationIds = patch.holds;
    if (patch.estimatedMicro !== undefined) set.estimatedMicro = patch.estimatedMicro;
    if (patch.chargedMicro !== undefined) set.chargedMicro = patch.chargedMicro;
    if (patch.owedMicro !== undefined) set.owedMicro = patch.owedMicro;
    if (patch.refundedMicro !== undefined) set.refundedMicro = patch.refundedMicro;
    if (patch.state !== undefined) set.state = patch.state;
    if (patch.wouldReject !== undefined) set.wouldReject = patch.wouldReject;
    if (patch.incomplete !== undefined) set.incomplete = patch.incomplete ? 1 : 0;
    if (patch.settledCostDigest !== undefined) set.settledCostDigest = patch.settledCostDigest;
    if (patch.settledAt !== undefined) {
      set.settledAt = patch.settledAt === null ? null : new Date(patch.settledAt);
    }
    if (Object.keys(set).length === 0) return;
    await this.db.update(runCharges).set(set).where(eq(runCharges.runId, runId));
  }

  async runForSettle(runId: string): Promise<RunForSettle | null> {
    const [row] = await this.db
      .select({
        status: runs.status,
        cost: runs.cost,
        pricing: runs.pricing,
        startedAt: runs.startedAt,
        usageSnapshot: runs.usageSnapshot,
        costDigest: COST_DIGEST,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    return row
      ? {
          status: row.status,
          cost: row.cost,
          // "受理时不可用"的标记没有价目:按没有锁定价目处理
          pricing: isUnavailableAtAdmission(row.pricing as PinnedPricing | null)
            ? null
            : ((row.pricing as RunPricing | null) ?? null),
          startedAt: row.startedAt?.getTime() ?? null,
          usageSnapshot: row.usageSnapshot ?? null,
          costDigest: row.costDigest ?? null,
        }
      : null;
  }

  async openOfFinishedRuns(limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: runCharges.runId })
      .from(runCharges)
      .innerJoin(runs, eq(runs.id, runCharges.runId))
      .where(
        or(
          and(
            eq(runCharges.state, "open"),
            inArray(runs.status, TERMINAL),
            // 取消接口先改状态,worker 中止后才补记花费:没有花费的先等一段宽限期再处理;
            // 过了宽限期仍没有花费的也只是暂记(provisional),迟到的花费还会补结算
            or(isNotNull(runs.cost), lt(runs.endedAt, new Date(Date.now() - SWEEP_GRACE_MS))),
          ),
          // 暂记之后花费变了(补记上了、补齐了明细):worker 那次结算没成功时由清扫补上。
          // 指纹在库里比,没变化的暂记不会被反复捞出来、挤掉别的待清扫记录
          and(
            eq(runCharges.state, "provisional"),
            sql`COALESCE(${runs.cost}, ${runs.usageSnapshot}) IS NOT NULL`,
            or(
              isNull(runCharges.settledCostDigest),
              sql`${runCharges.settledCostDigest} <> ${COST_DIGEST}`,
            ),
          ),
          // 欠款未收齐、而账户余额已经够补(充值之后):补扣。余额还不够的不捞,免得每轮都捞同一批
          and(
            eq(runCharges.state, "provisional"),
            sql`${runCharges.owedMicro} > 0`,
            sql`EXISTS (SELECT 1 FROM ${billingWallets} WHERE ${billingWallets.accountId} = ${runCharges.accountId} AND ${billingWallets.availableMicroCredits} >= ${runCharges.owedMicro})`,
          ),
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
