// 消耗汇总:按来源、智能体、API Key(管理员另有账号)把运行计费记录归组。纯逻辑。
//
// 金额口径与受理时的月度额度检查一致(见 monthUsedSql):冻结中的记冻结额,其余记净扣 + 欠额。
// 这样"本月"的合计就等于积分页上的"本月已用",两处数字对得上。

import { monthWindowUtc } from "./run-charge";

export const SUMMARY_WINDOWS = ["this_month", "last_month", "30d", "90d"] as const;
export type SummaryWindow = (typeof SUMMARY_WINDOWS)[number];

export const SUMMARY_DIMENSIONS = ["source", "agent", "key", "account"] as const;
export type SummaryDimension = (typeof SUMMARY_DIMENSIONS)[number];

/**
 * 对用户展示的来源。会话的 source 里 api(用 Key 建的多轮会话)与 invoke(一次性调用)
 * 对用户都是"系统通过 API 用的",合并为 api;按 Key 的维度还能再细分。
 */
export const CHARGE_SOURCES = ["web", "api", "design", "eval", "other"] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

export const CHARGE_SOURCE_LABEL: Record<ChargeSource, string> = {
  web: "网页对话",
  api: "API 调用",
  design: "AI 编辑",
  eval: "评测",
  other: "其他",
};

/** 会话来源 → 展示来源(SQL 里用同一张表归组,见 mysql-run-charge-query) */
export const SESSION_SOURCE_TO_CHARGE: Record<string, ChargeSource> = {
  web: "web",
  api: "api",
  invoke: "api",
  design: "design",
  eval: "eval",
};

export function isSummaryWindow(v: unknown): v is SummaryWindow {
  return typeof v === "string" && (SUMMARY_WINDOWS as readonly string[]).includes(v);
}

export function isSummaryDimension(v: unknown): v is SummaryDimension {
  return typeof v === "string" && (SUMMARY_DIMENSIONS as readonly string[]).includes(v);
}

export function isChargeSource(v: unknown): v is ChargeSource {
  return typeof v === "string" && (CHARGE_SOURCES as readonly string[]).includes(v);
}

/** 统计窗口 [since, until),按受理时间(run_charges.created_at)归属;本月、上月与额度检查同一个自然月 */
export function summaryWindow(w: SummaryWindow, now: number): { since: number; until: number } {
  const month = monthWindowUtc(now);
  switch (w) {
    case "this_month":
      return month;
    case "last_month":
      return monthWindowUtc(month.since - 1);
    case "30d":
      return { since: now - 30 * 86_400_000, until: now + 1 };
    case "90d":
      return { since: now - 90 * 86_400_000, until: now + 1 };
  }
}

/** 一组的汇总。金额都是微积分字符串 */
export interface ChargeSummaryRow {
  /** 组的标识:来源代码 / 智能体 id / Key id / 账号 id;网页发起没有 Key、智能体已不存在时为 null */
  key: string | null;
  /** 智能体名、Key 名、账号邮箱;来源由界面按 CHARGE_SOURCE_LABEL 显示 */
  name: string | null;
  runs: number;
  /** 已结算(含暂记)的净扣,多扣退还后的 */
  chargedMicro: string;
  /** 余额不足没扣成、充值后自动补扣的 */
  owedMicro: string;
  /** 还在运行、尚未结算的冻结额 */
  reservedMicro: string;
  /** 合计 = 冻结中 + 净扣 + 欠额(与月度额度同一口径) */
  usedMicro: string;
}

/** 各组相加 */
export function totalOf(rows: ChargeSummaryRow[]): Omit<ChargeSummaryRow, "key" | "name"> {
  const sum = (f: "chargedMicro" | "owedMicro" | "reservedMicro" | "usedMicro") =>
    rows.reduce((n, r) => n + BigInt(r[f]), 0n).toString();
  return {
    runs: rows.reduce((n, r) => n + r.runs, 0),
    chargedMicro: sum("chargedMicro"),
    owedMicro: sum("owedMicro"),
    reservedMicro: sum("reservedMicro"),
    usedMicro: sum("usedMicro"),
  };
}
