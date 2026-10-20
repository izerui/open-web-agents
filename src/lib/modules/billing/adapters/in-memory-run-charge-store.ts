import type { BillingMode } from "../domain/run-charge";
import { BillingError, type WalletBalance } from "../ports";
import type {
  ChargeTransaction,
  RunCharge,
  RunChargeStore,
  RunForSettle,
} from "../run-charge-ports";

interface World {
  wallets: Map<string, { available: bigint; reserved: bigint }>;
  reservations: Map<string, { accountId: string; amount: bigint; charged: bigint | null }>;
  refunds: Map<string, { accountId: string; amount: bigint }>;
  charges: Map<string, RunCharge>;
  runs: Map<string, RunForSettle>;
  accountLimits: Map<string, bigint>;
  legacyPending: Set<string>;
  keyLimits: Map<string, bigint>;
}

function clone(w: World): World {
  return {
    wallets: new Map([...w.wallets].map(([k, v]) => [k, { ...v }])),
    reservations: new Map([...w.reservations].map(([k, v]) => [k, { ...v }])),
    refunds: new Map([...w.refunds].map(([k, v]) => [k, { ...v }])),
    charges: new Map([...w.charges].map(([k, v]) => [k, structuredClone(v)])),
    runs: new Map([...w.runs].map(([k, v]) => [k, structuredClone(v)])),
    accountLimits: new Map(w.accountLimits),
    legacyPending: new Set(w.legacyPending),
    keyLimits: new Map(w.keyLimits),
  };
}

/** 测试用:事务全局串行;fn 抛错就整体还原,模拟回滚 */
export class InMemoryChargeWorld {
  private world: World = {
    wallets: new Map(),
    reservations: new Map(),
    refunds: new Map(),
    charges: new Map(),
    runs: new Map(),
    accountLimits: new Map(),
    legacyPending: new Set(),
    keyLimits: new Map(),
  };
  private chain: Promise<unknown> = Promise.resolve();

  readonly transaction: ChargeTransaction = <T>(fn: (store: RunChargeStore) => Promise<T>) => {
    const run = this.chain.then(async () => {
      const before = clone(this.world);
      try {
        return await fn(new Store(this.world));
      } catch (err) {
        this.world = before;
        throw err;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  };

  credit(accountId: string, micro: bigint) {
    const w = this.world.wallets.get(accountId) ?? { available: 0n, reserved: 0n };
    w.available += micro;
    this.world.wallets.set(accountId, w);
  }
  balance(accountId: string) {
    return this.world.wallets.get(accountId) ?? { available: 0n, reserved: 0n };
  }
  setAccountLimit(accountId: string, micro: bigint) {
    this.world.accountLimits.set(accountId, micro);
  }
  /** 模拟升级遗留:配置过美元上限、还没按积分重新设置 */
  setLegacyPending(accountId: string) {
    this.world.legacyPending.add(accountId);
  }
  setKeyLimit(keyId: string, micro: bigint) {
    this.world.keyLimits.set(keyId, micro);
  }
  setRun(runId: string, run: RunForSettle) {
    this.world.runs.set(runId, structuredClone(run));
  }
  /** 钱包里真正扣掉的净额(各笔冻结结算时的实扣之和,减去退还) —— 核对记录与钱包是否一致 */
  deducted(accountId: string) {
    let total = 0n;
    for (const r of this.world.reservations.values()) {
      if (r.accountId === accountId && r.charged !== null) total += r.charged;
    }
    for (const r of this.world.refunds.values()) {
      if (r.accountId === accountId) total -= r.amount;
    }
    return total;
  }
  charge(runId: string) {
    return structuredClone(this.world.charges.get(runId) ?? null);
  }
  charges() {
    return [...this.world.charges.values()].map((c) => structuredClone(c));
  }
}

class Store implements RunChargeStore {
  constructor(private readonly w: World) {}

  private wallet(accountId: string) {
    let x = this.w.wallets.get(accountId);
    if (!x) {
      x = { available: 0n, reserved: 0n };
      this.w.wallets.set(accountId, x);
    }
    return x;
  }

  async lockAccount(accountId: string): Promise<WalletBalance> {
    const x = this.wallet(accountId);
    return {
      accountId,
      availableMicroCredits: x.available.toString(),
      reservedMicroCredits: x.reserved.toString(),
    };
  }

  async monthUsage(f: {
    accountId?: string;
    apiKeyId?: string;
    mode: BillingMode;
    since: number;
    until: number;
  }) {
    let total = 0n;
    for (const c of this.w.charges.values()) {
      if (c.mode !== f.mode || c.createdAt < f.since || c.createdAt >= f.until) continue;
      if (f.accountId && c.accountId !== f.accountId) continue;
      if (f.apiKeyId && c.apiKeyId !== f.apiKeyId) continue;
      // 口径同 monthUsedSql:正式 = 实扣 + 已确认欠额;试算 = 预计;冻结中 = 冻结额
      const settled =
        f.mode === "live"
          ? BigInt(c.chargedMicro ?? "0") + BigInt(c.owedMicro ?? "0")
          : BigInt(c.estimatedMicro ?? "0");
      total += c.state === "open" ? BigInt(c.reservedMicro) : settled;
    }
    return total;
  }

  async openTrialReserved(accountId: string) {
    let total = 0n;
    for (const c of this.w.charges.values()) {
      if (c.accountId === accountId && c.mode === "trial" && c.state === "open") {
        total += BigInt(c.reservedMicro);
      }
    }
    return total;
  }

  async accountLimit(accountId: string) {
    const limit = this.w.accountLimits.get(accountId) ?? null;
    return { limit, pending: limit === null && this.w.legacyPending.has(accountId) };
  }

  async keyLimit(apiKeyId: string) {
    return this.w.keyLimits.get(apiKeyId) ?? null;
  }

  async reserveWallet(accountId: string, reservationId: string, amount: bigint) {
    if (this.w.reservations.has(reservationId)) return;
    const x = this.wallet(accountId);
    if (x.available < amount) throw new BillingError(402, "insufficient_balance", "积分不足");
    x.available -= amount;
    x.reserved += amount;
    this.w.reservations.set(reservationId, { accountId, amount, charged: null });
  }

  async settleWallet(accountId: string, reservationId: string, charged: bigint) {
    const r = this.w.reservations.get(reservationId);
    if (!r) throw new BillingError(404, "reservation_not_found", "预占不存在");
    if (r.charged !== null) return;
    if (charged > r.amount) throw new BillingError(409, "charge_exceeds_reservation", "超出预占");
    const x = this.wallet(accountId);
    x.reserved -= r.amount;
    x.available += r.amount - charged;
    r.charged = charged;
  }

  async refundWallet(accountId: string, refundId: string, amount: bigint) {
    const prior = this.w.refunds.get(refundId);
    if (prior) {
      if (prior.amount !== amount)
        throw new BillingError(409, "idempotency_conflict", "退还金额不一致");
      return;
    }
    this.wallet(accountId).available += amount;
    this.w.refunds.set(refundId, { accountId, amount });
  }

  async insert(c: RunCharge) {
    if (this.w.charges.has(c.runId)) throw new Error("duplicate run charge");
    this.w.charges.set(c.runId, structuredClone(c));
  }

  async get(runId: string) {
    return structuredClone(this.w.charges.get(runId) ?? null);
  }

  async update(runId: string, patch: Partial<Omit<RunCharge, "runId">>) {
    const c = this.w.charges.get(runId);
    if (c) this.w.charges.set(runId, { ...c, ...structuredClone(patch) });
  }

  async runForSettle(runId: string): Promise<RunForSettle | null> {
    const run = this.w.runs.get(runId);
    return run ? { ...structuredClone(run), costDigest: runDigest(run) } : null;
  }

  async openOfFinishedRuns(limit: number) {
    return [...this.w.charges.values()]
      .filter((c) => {
        const run = this.w.runs.get(c.runId);
        if (c.state === "provisional") {
          const owed = BigInt(c.owedMicro ?? "0");
          if (owed > 0n && (this.w.wallets.get(c.accountId)?.available ?? 0n) >= owed) return true;
          const digest = run ? runDigest(run) : null;
          return digest !== null && digest !== c.settledCostDigest;
        }
        return c.state === "open" && ["success", "failed", "cancelled"].includes(run?.status ?? "");
      })
      .slice(0, limit)
      .map((c) => c.runId);
  }
}

/** 同 MySQL 的 COST_DIGEST:最终费用原样,快照加来源前缀 */
function runDigest(run: RunForSettle): string | null {
  if (run.cost != null) return digestOf(run.cost);
  if (run.usageSnapshot != null) return `snapshot:${digestOf(run.usageSnapshot)}`;
  return null;
}

function digestOf(cost: unknown): string | null {
  return cost === null || cost === undefined ? null : JSON.stringify(cost);
}
