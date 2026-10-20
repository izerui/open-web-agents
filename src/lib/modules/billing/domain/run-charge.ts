// 运行计费的纯规则:冻结额怎么定、什么时候算"不够"、结束时怎么拆分扣款。全程 bigint 微积分。

export type BillingMode = "trial" | "live";
export const BILLING_MODES: readonly BillingMode[] = ["trial", "live"];

export type HoldRejection =
  | "insufficient_balance"
  | "account_limit_exceeded"
  | "key_limit_exceeded"
  /** 账号配置过旧的美元月度上限,还没按积分重新设置(升级遗留,待管理员处理) */
  | "account_limit_pending";

/** 可用余额低于它就不再受理(20 积分) */
export const MIN_BALANCE_MICRO = 20_000_000n;
/** 模型没配单次冻结额时用它(300 积分,约一次多步运行的上限) */
export const DEFAULT_RESERVE_MICRO = 300_000_000n;

export interface HoldInput {
  /** 想冻结的额度(模型的单次冻结额) */
  target: bigint;
  /** 可用余额(正式 = 钱包可用;试算 = 钱包可用 − 在途试算冻结) */
  available: bigint;
  /** 账号本月剩余(上限 − 已用 − 在途);null = 不限 */
  accountRemaining: bigint | null;
  /** Key 本月剩余;null = 不限或不是 Key 发起 */
  keyRemaining: bigint | null;
  /** 追加冻结时不看最低门槛:运行已经开始,只要还能冻结一点就继续 */
  topUp?: boolean;
}

export interface HoldDecision {
  /** 实际冻结额;有拒绝原因时为 0 */
  amount: bigint;
  rejection: HoldRejection | null;
}

/** 冻结额 = min(目标, 可用余额, 账号剩余, Key 剩余);任一项不够就给出拒绝原因。 */
export function decideHold(input: HoldInput): HoldDecision {
  if (input.accountRemaining !== null && input.accountRemaining <= 0n) {
    return { amount: 0n, rejection: "account_limit_exceeded" };
  }
  if (input.keyRemaining !== null && input.keyRemaining <= 0n) {
    return { amount: 0n, rejection: "key_limit_exceeded" };
  }
  const floor = input.topUp ? 1n : MIN_BALANCE_MICRO;
  if (input.available < floor) return { amount: 0n, rejection: "insufficient_balance" };
  let amount = input.target;
  for (const cap of [input.available, input.accountRemaining, input.keyRemaining]) {
    if (cap !== null && cap < amount) amount = cap;
  }
  return { amount, rejection: null };
}

/** 本月起点(UTC)。月度上限按自然月重置 */
export function monthStartUtc(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * 某时刻所在自然月的统计窗口 [since, until)。
 * 月度占用按【受理月份】归属:一次运行受理时的冻结与之后每一次追加都记在受理那个月,
 * 追加时也按那个月检查 —— 月底受理、月初还在跑的运行,追加的冻结不会从任何一个月的统计里消失。
 */
export function monthWindowUtc(at: number): { since: number; until: number } {
  const d = new Date(at);
  return {
    since: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    until: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** 月度上限的剩余额度;上限为空表示不限 */
export function remaining(limit: bigint | null, used: bigint): bigint | null {
  return limit === null ? null : limit - used;
}

export const REJECTION_MESSAGE: Record<HoldRejection, string> = {
  insufficient_balance: "积分不足,请充值或联系管理员",
  account_limit_exceeded: "已达到账号本月积分上限",
  key_limit_exceeded: "已达到这把 API Key 本月积分上限",
  account_limit_pending: "账号的月度上限需要管理员按积分重新设置,设置前不能发起运行",
};

export interface HoldSlice {
  id: string;
  amount: string;
}

export interface SettlementPlan {
  /** 每笔冻结实际扣多少(其余释放) */
  settles: { id: string; charged: bigint }[];
  /** 超出全部冻结的部分(触发停止的那次请求、子代理并发),需要另行补扣 */
  over: bigint;
}

/** 按冻结的先后把应扣额度摊到各笔冻结上,每笔不超过自身额度。 */
export function planSettlement(due: bigint, holds: readonly HoldSlice[]): SettlementPlan {
  let left = due < 0n ? 0n : due;
  const settles = holds.map((h) => {
    const amount = BigInt(h.amount);
    const charged = left < amount ? left : amount;
    left -= charged;
    return { id: h.id, charged };
  });
  return { settles, over: left };
}
