import type { RunPricing } from "@/lib/shared";
import type { ReconRow } from "./domain/reconciliation";
import type { BillingMode, HoldRejection, HoldSlice } from "./domain/run-charge";
import type { WalletBalance } from "./ports";

export interface RunCharge {
  runId: string;
  accountId: string;
  apiKeyId: string | null;
  mode: BillingMode;
  /** 累计冻结(正式 = 钱包里各笔冻结之和;试算 = 只记在这里) */
  reservedMicro: string;
  /** 正式模式下钱包里的各笔冻结;试算为空 */
  holds: HoldSlice[];
  estimatedMicro: string | null;
  /** 净扣:已扣减去已退还 */
  chargedMicro: string | null;
  owedMicro: string | null;
  /** 自动退还的多扣累计 */
  refundedMicro: string | null;
  /**
   * open = 冻结中;settled = 已结清;
   * provisional = 运行已结束,但用量还不能完整计价:跑过却没拿到用量(取消、worker 失联、引擎异常),
   * 或拿到的计量认不出模型、缺价目。冻结已释放,能计价的部分已按实扣/预计记上,标为不完整;
   * 花费之后变了(补记、补齐明细)再补结算差额,能完整计价时转 settled。
   */
  state: ChargeState;
  wouldReject: HoldRejection | null;
  incomplete: boolean;
  /** 上次结算时运行花费的指纹:暂记的记录花费变了(补记、补齐明细)才需要再结算 */
  settledCostDigest: string | null;
  /** 等最终费用的期限过后已结算过(清扫不再为期限选它) */
  finalWaitSettled: boolean;
  createdAt: number;
  settledAt: number | null;
}

export type ChargeState = "open" | "provisional" | "settled";

/** 结算要读的运行信息 */
export interface RunForSettle {
  status: string;
  cost: unknown;
  pricing: RunPricing | null;
  /** 被 worker 认领的时刻;null = 从没开始执行(确认没有调用模型) */
  startedAt: number | null;
  /** 运行结束时刻(仅供参考;期限是否已过以 finalCostWaitOver 为准) */
  endedAt?: number | null;
  /**
   * 等最终费用的期限(运行结束起 24 小时)是否已过。由存储用数据库自己的时钟与运行表自己的时间算,
   * 不拿应用的时钟去比 —— 两边时区约定不同时会差出几个小时
   */
  finalCostWaitOver?: boolean;
  /** 运行中的累计用量快照;没有最终费用时用于结算(视为不完整) */
  usageSnapshot?: unknown;
  /** 花费的指纹(没有最终费用时为快照的指纹;都没有为 null),由存储计算 */
  costDigest?: string | null;
}

/** 账号的月度上限 */
export interface AccountLimit {
  /** null = 不限 */
  limit: bigint | null;
  /** 配置过旧的美元上限、还没按积分重新设置:正式模式下不受理 */
  pending: boolean;
}

/**
 * 计费存储。所有方法都在调用方开的同一个事务里执行:先 lockAccount 拿到账户行锁,
 * 之后的汇总、冻结、写入对同一账户串行 —— 并发运行不会重复占用同一份额度。
 */
export interface RunChargeStore {
  /** 锁账户钱包行(没有就建)并返回余额 */
  lockAccount(accountId: string): Promise<WalletBalance>;
  /**
   * 某个自然月 [since, until) 内受理的运行按某计费模式的占用(按受理月份归属,见 monthWindowUtc):
   * 冻结中按冻结额(含跨月追加);正式结算过的按实扣 + 已确认欠额;试算按预计消耗
   */
  monthUsage(filter: {
    accountId?: string;
    apiKeyId?: string;
    mode: BillingMode;
    since: number;
    until: number;
  }): Promise<bigint>;
  /** 账号在途的试算冻结(试算的"可用余额"要扣掉它) */
  openTrialReserved(accountId: string): Promise<bigint>;
  accountLimit(accountId: string): Promise<AccountLimit>;
  keyLimit(apiKeyId: string): Promise<bigint | null>;
  /** 钱包冻结 / 结算(正式模式);与本事务同进退 */
  reserveWallet(accountId: string, reservationId: string, amount: bigint): Promise<void>;
  settleWallet(accountId: string, reservationId: string, charged: bigint): Promise<void>;
  /** 退还多扣到可用余额;与本事务同进退,同编号只生效一次 */
  refundWallet(accountId: string, refundId: string, amount: bigint): Promise<void>;
  insert(charge: RunCharge): Promise<void>;
  /** forUpdate:锁住这一行直到事务结束(结算、追加互斥) */
  get(runId: string, forUpdate?: boolean): Promise<RunCharge | null>;
  update(runId: string, patch: Partial<Omit<RunCharge, "runId">>): Promise<void>;
  runForSettle(runId: string): Promise<RunForSettle | null>;
  /** 运行已经结束但还没结清的:open 的,以及 provisional 且用量已补记的(清扫补结算用) */
  openOfFinishedRuns(limit: number): Promise<string[]>;
}

/** 在一个事务里使用计费存储 */
export type ChargeTransaction = <T>(fn: (store: RunChargeStore) => Promise<T>) => Promise<T>;

/** 全局计费模式;只决定新受理的运行 */
export interface BillingModeStore {
  get(): Promise<BillingMode>;
  set(mode: BillingMode): Promise<void>;
}

/** 积分页里的一次运行:受理时的模式、冻结、预计消耗与实际扣除 */
export interface RunChargeItem {
  runId: string;
  mode: BillingMode;
  state: ChargeState;
  reservedMicro: string;
  estimatedMicro: string | null;
  /** 净扣:已扣减去已退还 */
  chargedMicro: string | null;
  owedMicro: string | null;
  /** 自动退还的多扣累计 */
  refundedMicro: string | null;
  wouldReject: HoldRejection | null;
  incomplete: boolean;
  createdAt: number;
  settledAt: number | null;
  /** 运行所属智能体名称(已删除为 null) */
  agentName: string | null;
  apiKeyId: string | null;
}

export interface TrialStats {
  /** 统计起点(本月,UTC) */
  since: number;
  runs: number;
  /** 已结算试算运行的预计消耗合计 */
  estimatedMicro: string;
  /** 本应拒绝的次数 */
  wouldReject: number;
}

/**
 * 暂记(待核对)的原因。按这个优先级归类,一条记录只归一类:
 * - owed:用量完整,但余额不够,还欠着(充值后清扫自动补扣)
 * - usage_unknown:运行过,但结算时没有拿到任何用量
 * - unpriced:有用量,但连本次运行主模型的价目都取不到,暂时无法计价(认不出的模型已按主模型价计,不会落到这里)
 */
export type PendingReason = "owed" | "usage_unknown" | "unpriced";
export const PENDING_REASONS: readonly PendingReason[] = ["owed", "usage_unknown", "unpriced"];

/** 跨账号的待核对列表里的一条 */
export interface PendingChargeItem extends RunChargeItem {
  reason: PendingReason;
  accountId: string;
  /** 账号邮箱(账号已删除为 null) */
  accountEmail: string | null;
}

/** 对账报表的一行原始数据(价目版本由应用层按 pricing 取) */
export interface ReconRawRow extends Omit<ReconRow, "models"> {
  pricing: RunPricing | null;
}

/** 只读查询:积分页、账号与 Key 的本月用量、试算统计、待核对列表 */
export interface RunChargeQuery {
  listByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: RunChargeItem[]; nextCursor?: string }>;
  /** 本月各账号用量(口径同受理时的额度检查) */
  monthUsageByAccount(mode: BillingMode, since: number): Promise<Map<string, bigint>>;
  /** 本月某账号下各 Key 的用量 */
  monthUsageByKey(
    accountId: string,
    mode: BillingMode,
    since: number,
  ): Promise<Map<string, bigint>>;
  trialStats(since: number): Promise<TrialStats>;
  /** 所有账号的暂记记录(按受理时间倒序),可按原因与计费模式筛选;只读 */
  listPending(opts: {
    reason?: PendingReason;
    mode?: BillingMode;
    limit: number;
    cursor?: string;
  }): Promise<{ items: PendingChargeItem[]; nextCursor?: string }>;
  /**
   * 对账报表的原始数据:[from, to] 两天之间(含)创建的运行,一次运行一行。
   * 日期与区间都按数据库时钟(运行表自己的创建时间)算。超过 limit 截断并说明。
   */
  reconciliationRows(opts: {
    from: string;
    to: string;
    mode?: BillingMode;
    limit: number;
  }): Promise<{ rows: ReconRawRow[]; truncated: boolean }>;
  /** 各原因的暂记条数(可按计费模式筛选) */
  pendingCounts(mode?: BillingMode): Promise<Record<PendingReason, number>>;
}
