// 积分与套餐页的展示判断:纯函数,便于测试。

import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry } from "@/lib/modules/billing/ports";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";

export const BILLING_TABS = ["overview", "packages", "ledger", "runs"] as const;
export type BillingTab = (typeof BILLING_TABS)[number];

export const BILLING_TAB_LABEL: Record<BillingTab, string> = {
  overview: "概览",
  packages: "充值与订单",
  ledger: "账户流水",
  runs: "运行消耗",
};

/** 地址里的 ?tab= → 页签;原型锚点 cost 等同 runs,其余不认识的回到概览 */
export function billingTab(raw: string | null | undefined): BillingTab {
  if (raw === "cost") return "runs";
  return (BILLING_TABS as readonly string[]).includes(raw ?? "") ? (raw as BillingTab) : "overview";
}

export type LedgerTone = "success" | "warning" | "default" | "outline";

/** 流水一行的类型名、正负号与标签色 */
export function ledgerKind(e: Pick<LedgerEntry, "kind" | "amountMicroCredits">): {
  label: string;
  sign: "+" | "-" | "";
  tone: LedgerTone;
} {
  switch (e.kind) {
    case "credit":
      return { label: "人工入账", sign: "+", tone: "success" };
    case "refund":
      return { label: "多扣退还", sign: "+", tone: "success" };
    case "reserve":
      return { label: "冻结", sign: "-", tone: "warning" };
    case "settle":
      return e.amountMicroCredits === "0"
        ? { label: "释放冻结", sign: "", tone: "outline" }
        : { label: "结算", sign: "-", tone: "default" };
  }
}

/** 本月已用占月度上限的百分比;没有上限返回 null */
export function monthShare(
  month: { usedMicroCredits: string; limitMicroCredits: string | null } | undefined,
): number | null {
  if (!month || month.limitMicroCredits === null) return null;
  const used = BigInt(month.usedMicroCredits);
  const limit = BigInt(month.limitMicroCredits);
  if (limit <= 0n || used >= limit) return 100;
  return Number((used * 100n) / limit);
}

/**
 * 一次运行的扣费状态(运行消耗明细):冻结中 / 已结算 / 多扣已退还 / 欠额 / 待核对,
 * note 是补充说明(欠多少、为什么待核对)。
 */
export function chargeStatus(c: {
  state: "open" | "provisional" | "settled";
  owedMicro: string | null;
  refundedMicro: string | null;
  incomplete: boolean;
}): { label: string; tone: "warning" | "success" | "destructive" | "default"; note: string } {
  const has = (v: string | null) => Boolean(v && v !== "0");
  const refunded = has(c.refundedMicro)
    ? `多扣的 ${creditsAmount(c.refundedMicro as string)} 积分已退还`
    : "";
  if (c.state === "open") {
    return { label: "冻结中", tone: "warning", note: "运行结束后按实际用量结算" };
  }
  if (c.state === "provisional") {
    if (has(c.owedMicro)) {
      return {
        label: "欠额",
        tone: "destructive",
        note: `余额不足,欠 ${creditsAmount(c.owedMicro as string)} 积分,充值后自动补扣`,
      };
    }
    return {
      label: "待核对",
      tone: "default",
      note: ["用量待补记", refunded].filter(Boolean).join(";"),
    };
  }
  if (has(c.owedMicro)) return { label: "待核对", tone: "default", note: "余额不足补扣" };
  if (c.incomplete) return { label: "待核对", tone: "default", note: "用量不完整" };
  if (refunded) return { label: "多扣已退还", tone: "success", note: refunded };
  return { label: "已结算", tone: "success", note: "" };
}

/** 条形宽度:占最大值的百分比;有值的至少 2%,免得看不见 */
export function shareOf(value: string, max: string): number {
  const v = BigInt(value);
  const m = BigInt(max);
  if (v <= 0n || m <= 0n) return 0;
  return Math.max(2, Number((v * 100n) / m));
}

/** 积分包按积分数从少到多(库里按 id 字符串排,1000、10500、3090 这样会乱) */
export function sortByCredits<T extends { id: string; creditsMicro: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const d = BigInt(a.creditsMicro) - BigInt(b.creditsMicro);
    return d === 0n ? a.id.localeCompare(b.id) : d < 0n ? -1 : 1;
  });
}

/** 管理端订单页签的统计卡:待处理数,以及本月(本地时区)确认的订单发放的积分和按币种的收款 */
export function orderStats(
  orders: {
    status: "pending" | "credited" | "cancelled";
    creditsMicro: string;
    priceMinor: string;
    currency: "CNY" | "USD";
    creditedAt?: number;
  }[],
  now: number,
): { pending: number; creditedMicro: string; cnyMinor: string; usdMinor: string } {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  let credited = 0n;
  const paid = { CNY: 0n, USD: 0n };
  let pending = 0;
  for (const o of orders) {
    if (o.status === "pending") pending++;
    if (o.status === "credited" && (o.creditedAt ?? 0) >= monthStart) {
      credited += BigInt(o.creditsMicro);
      paid[o.currency] += BigInt(o.priceMinor);
    }
  }
  return {
    pending,
    creditedMicro: credited.toString(),
    cnyMinor: paid.CNY.toString(),
    usdMinor: paid.USD.toString(),
  };
}

/** 批量发放:输入框里已识别的邮箱个数(拆分规则同服务端 parseEmailList) */
export function countEmails(text: string): number {
  return text.split(/[\s,;，；]+/).filter((s) => s.trim()).length;
}

/** 批量发放预览汇总:可发放人数、跳过人数、合计积分(微积分;积分填错为 null) */
export function batchSummary(
  lines: { status: string }[],
  credits: string,
): { ready: number; skipped: number; totalMicro: string | null } {
  const ready = lines.filter((l) => l.status === "ready").length;
  let totalMicro: string | null = null;
  try {
    totalMicro = (BigInt(parseCredits(credits.trim())) * BigInt(ready)).toString();
  } catch {
    totalMicro = null;
  }
  return { ready, skipped: lines.length - ready, totalMicro };
}

/** 积分折合人民币(1 元 = 100 积分),到分为止;整元不带小数 */
export function creditsToYuan(micro: string): string {
  const cents = BigInt(micro) / 1_000_000n;
  const yuan = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = cents % 100n;
  return rest === 0n ? yuan : `${yuan}.${rest.toString().padStart(2, "0")}`;
}

/** 对账表的合计行:各列相加;不完整数据 = 运行数 - 完整数 */
export function reconTotals(
  lines: {
    runs: number;
    counts: Partial<Record<string, number>>;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costMicro: string;
    estimatedMicro: string;
    chargedMicro: string;
  }[],
) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let runs = 0;
  let complete = 0;
  let cost = 0n;
  let est = 0n;
  let charged = 0n;
  for (const l of lines) {
    runs += l.runs;
    complete += l.counts.complete ?? 0;
    tokens.input += l.tokens.input;
    tokens.output += l.tokens.output;
    tokens.cacheRead += l.tokens.cacheRead;
    tokens.cacheWrite += l.tokens.cacheWrite;
    cost += BigInt(l.costMicro);
    est += BigInt(l.estimatedMicro);
    charged += BigInt(l.chargedMicro);
  }
  return {
    runs,
    incomplete: runs - complete,
    tokens,
    costMicro: cost.toString(),
    estimatedMicro: est.toString(),
    chargedMicro: charged.toString(),
  };
}
