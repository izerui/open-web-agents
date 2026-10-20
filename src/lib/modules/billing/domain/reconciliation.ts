// 对账报表:按提供者、日期汇总已记录的用量与估算,供与上游账单核对。纯函数,只读。
//
// 和上游账单核对用的是"成本估算":按运行受理时锁定的价目版本、用成本单价算。
// 缺失数据(用量未知、没收到用量按 0 结清、未开始、进行中)只计条数,不计入估算 ——
// 它们不是"已核实为零"。

import { type ModelMetering, unattributedOf } from "@/lib/modules/agent-engine/domain/model-usage";
import { type Capability, type Meter, priceUsage } from "@/lib/modules/capabilities/domain/catalog";

/** 一次运行在报表里归哪一类(按数据来源) */
export type ReconCategory =
  | "complete" // 有最终费用,能完整计价
  | "unpriced" // 有最终费用,有认不出的模型或缺价目
  | "snapshot_provisional" // 没有最终费用,按运行中的用量快照暂记
  | "snapshot_settled" // 没有最终费用,期限过后按快照结清
  | "usage_unknown" // 运行过,一条用量数据都没有,暂记中
  | "no_usage_zero" // 运行过,没收到任何用量,按规则结清为 0
  | "not_started" // 从没开始执行
  | "open"; // 冻结中,还没结算

export const RECON_CATEGORIES: readonly ReconCategory[] = [
  "complete",
  "unpriced",
  "snapshot_provisional",
  "snapshot_settled",
  "usage_unknown",
  "no_usage_zero",
  "not_started",
  "open",
];

/** 一次运行的原始数据(存储查出来的) */
export interface ReconRow {
  day: string; // YYYY-MM-DD(按数据库时钟)
  providerId: string | null;
  state: "open" | "provisional" | "settled";
  started: boolean;
  finalWaitSettled: boolean;
  estimatedMicro: string | null;
  chargedMicro: string | null;
  /** 最终费用(runs.cost);没有为 null */
  cost: unknown;
  /** 运行中的用量快照;没有为 null */
  snapshot: unknown;
  /** 锁定的价目版本快照(含成本价);取不到为 null */
  models: Capability[] | null;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ReconLine {
  day: string;
  providerId: string | null;
  runs: number;
  counts: Record<ReconCategory, number>;
  /** 有用量数据(完整、无法完整计价、快照)的运行的 token 合计 */
  tokens: Tokens;
  /** 认不出模型或缺价目、没计入估算的 token 合计 */
  unpricedTokens: Tokens;
  /** 按成本单价估算(微积分;1 元 = 100 积分),只含能计价的部分 */
  costMicro: string;
  /** 按售价算出的应扣(微积分,结算时记下的) */
  estimatedMicro: string;
  /** 实际扣除(微积分) */
  chargedMicro: string;
}

const ZERO_TOKENS = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function categorize(r: ReconRow): ReconCategory {
  if (r.state === "open") return "open";
  // 用量数据是否完整与是否结清无关(欠款的暂记,用量本身是完整的)
  if (r.cost != null) return isUnpriced(r) ? "unpriced" : "complete";
  if (r.snapshot != null) return r.finalWaitSettled ? "snapshot_settled" : "snapshot_provisional";
  if (!r.started) return "not_started";
  return r.state === "settled" ? "no_usage_zero" : "usage_unknown";
}

function meteringOf(v: unknown): ModelMetering | null {
  const m = (v as { metering?: ModelMetering } | null)?.metering;
  return m && Array.isArray(m.models) ? m : null;
}

/** 有最终费用但计量不完整或有模型无法计价 */
function isUnpriced(r: ReconRow): boolean {
  const m = meteringOf(r.cost);
  if (!m || !m.complete || !r.models) return true;
  return m.models.some((u) => !capOf(r.models ?? [], u.modelId));
}

function capOf(models: Capability[], modelId: string): Capability | undefined {
  const hits = models.filter((c) => c.kind === "llm" && c.modelId === modelId);
  return hits.length === 1 ? hits[0] : undefined;
}

/** 按成本单价估一份计量;返回能计价的微积分与无法计价的 token */
function costOf(metering: ModelMetering | null, models: Capability[] | null) {
  const priced = { micro: 0n, unpriced: ZERO_TOKENS() };
  for (const u of metering?.models ?? []) {
    const cap = models ? capOf(models, u.modelId) : undefined;
    const usage: Partial<Record<Meter, string>> = {};
    if (u.inputTokens > 0) usage.input_token = String(u.inputTokens);
    if (u.outputTokens > 0) usage.output_token = String(u.outputTokens);
    if (u.cacheReadTokens > 0) usage.cache_read_token = String(u.cacheReadTokens);
    if (u.cacheWriteTokens > 0) usage.cache_write_token = String(u.cacheWriteTokens);
    let ok = false;
    if (cap?.costRates) {
      try {
        priced.micro += BigInt(priceUsage(cap.costRates, usage).microCredits);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      priced.unpriced.input += u.inputTokens;
      priced.unpriced.output += u.outputTokens;
      priced.unpriced.cacheRead += u.cacheReadTokens;
      priced.unpriced.cacheWrite += u.cacheWriteTokens;
    }
  }
  return priced;
}

function add(a: Tokens, b: Tokens): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
}

export function buildReconciliation(rows: ReconRow[]): ReconLine[] {
  const lines = new Map<string, ReconLine & { cost: bigint; est: bigint; chg: bigint }>();
  for (const r of rows) {
    const key = `${r.day}|${r.providerId ?? ""}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        day: r.day,
        providerId: r.providerId,
        runs: 0,
        counts: Object.fromEntries(RECON_CATEGORIES.map((c) => [c, 0])) as Record<
          ReconCategory,
          number
        >,
        tokens: ZERO_TOKENS(),
        unpricedTokens: ZERO_TOKENS(),
        costMicro: "0",
        estimatedMicro: "0",
        chargedMicro: "0",
        cost: 0n,
        est: 0n,
        chg: 0n,
      };
      lines.set(key, line);
    }
    line.runs++;
    const category = categorize(r);
    line.counts[category]++;
    line.est += BigInt(r.estimatedMicro ?? "0");
    line.chg += BigInt(r.chargedMicro ?? "0");
    // 只有带用量数据的类别计入 token 与成本估算
    const source = r.cost ?? r.snapshot;
    const metering = source != null ? meteringOf(source) : null;
    if (!metering) continue;
    for (const u of metering.models) {
      add(line.tokens, {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheRead: u.cacheReadTokens,
        cacheWrite: u.cacheWriteTokens,
      });
    }
    const priced = costOf(metering, r.models);
    line.cost += priced.micro;
    add(line.unpricedTokens, priced.unpriced);
    // 没带模型名的用量:计入 token 合计;不知道是哪个模型,没有成本单价,单列为无法计价
    const una = unattributedOf(metering);
    if (una) {
      const t = {
        input: una.inputTokens,
        output: una.outputTokens,
        cacheRead: una.cacheReadTokens,
        cacheWrite: una.cacheWriteTokens,
      };
      add(line.tokens, t);
      add(line.unpricedTokens, t);
    }
  }
  return [...lines.values()]
    .map(({ cost, est, chg, ...l }) => ({
      ...l,
      costMicro: cost.toString(),
      estimatedMicro: est.toString(),
      chargedMicro: chg.toString(),
    }))
    .sort((a, b) =>
      a.day === b.day
        ? (a.providerId ?? "").localeCompare(b.providerId ?? "")
        : b.day.localeCompare(a.day),
    );
}
