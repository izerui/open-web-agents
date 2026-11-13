// 积分流水「说明」列:按流水类型和引用拼一句可读的话(运行带智能体名与来源、订单带套餐名),
// 不把 run:…:0、package-order:… 这样的内部引用直接给人看。
// 引用格式见 run-charging.ts(run:<id>:<n> / :over / :late:<n> / :refund:<n>)、
// mysql-package-repo.ts(package-order:<id>)、batch-credit.ts(batch:<key>);人工发放的引用是幂等键。

import {
  CHARGE_SOURCE_LABEL,
  SESSION_SOURCE_TO_CHARGE,
} from "@/lib/modules/billing/domain/charge-summary";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry } from "@/lib/modules/billing/ports";
import { shortOrderId } from "./order-number";

export type LedgerRef =
  | { type: "run"; runId: string; part: "hold"; n: number }
  | { type: "run"; runId: string; part: "over" | "late" | "refund" }
  | { type: "order"; orderId: string }
  | { type: "batch" }
  | { type: "other" };

/** 流水接口随列表带回的关联信息(只含本页用到的运行与订单) */
export interface LedgerRefs {
  runs: Record<string, { agentName: string | null; source: string | null }>;
  orders: Record<string, { packageName: string }>;
}

export function parseLedgerRef(reference: string): LedgerRef {
  const run = /^run:([^:]+):(\d+|over|late:\d+|refund:\d+)$/.exec(reference);
  if (run) {
    const runId = run[1] as string;
    const tail = run[2] as string;
    if (/^\d+$/.test(tail)) return { type: "run", runId, part: "hold", n: Number(tail) };
    if (tail === "over") return { type: "run", runId, part: "over" };
    return { type: "run", runId, part: tail.startsWith("late") ? "late" : "refund" };
  }
  const order = /^package-order:(.+)$/.exec(reference);
  if (order) return { type: "order", orderId: order[1] as string };
  if (reference.startsWith("batch:")) return { type: "batch" };
  return { type: "other" };
}

/** 一页流水里需要查名字的运行与订单(去重) */
export function ledgerRefIds(items: Pick<LedgerEntry, "reference">[]): {
  runIds: string[];
  orderIds: string[];
} {
  const runIds = new Set<string>();
  const orderIds = new Set<string>();
  for (const item of items) {
    const ref = parseLedgerRef(item.reference);
    if (ref.type === "run") runIds.add(ref.runId);
    else if (ref.type === "order") orderIds.add(ref.orderId);
  }
  return { runIds: [...runIds], orderIds: [...orderIds] };
}

function runAction(
  entry: Pick<LedgerEntry, "kind" | "amountMicroCredits">,
  ref: Extract<LedgerRef, { type: "run" }>,
): string {
  if (entry.kind === "refund" || ref.part === "refund")
    return `多扣的 ${creditsAmount(entry.amountMicroCredits)} 积分退还`;
  if (ref.part === "late") return "补记用量后补扣";
  if (ref.part === "over") return "超出冻结的部分补扣";
  if (entry.kind === "settle")
    return entry.amountMicroCredits === "0" ? "结束，冻结全部释放" : "按实际用量扣除";
  return ref.part === "hold" && ref.n > 0 ? "追加冻结" : "预冻结";
}

export function ledgerNote(
  entry: Pick<LedgerEntry, "kind" | "reference" | "amountMicroCredits" | "reason">,
  refs: LedgerRefs | undefined,
): string {
  const ref = parseLedgerRef(entry.reference);
  const reason = entry.reason?.trim();
  switch (ref.type) {
    case "run": {
      const head = `运行 ${ref.runId.slice(0, 8)} ${runAction(entry, ref)}`;
      const info = refs?.runs[ref.runId];
      if (!info) return head;
      const source = info.source
        ? CHARGE_SOURCE_LABEL[SESSION_SOURCE_TO_CHARGE[info.source] ?? "other"]
        : null;
      return `${head} · ${info.agentName ?? "已删除的智能体"}${source ? `（${source}）` : ""}`;
    }
    case "order": {
      const name = refs?.orders[ref.orderId]?.packageName;
      const base = `购买${name ? `「${name}」` : "积分包"}到账 · 订单 ${shortOrderId(ref.orderId)}`;
      return reason ? `${base} · ${reason}` : base;
    }
    case "batch":
      return reason ? `批量发放：${reason}` : "批量发放";
    default:
      if (entry.kind === "credit") return reason ? `人工发放：${reason}` : "人工发放";
      return reason || "其他";
  }
}

/** 翻页时把新一页的关联信息并进已有的 */
export function mergeRefs(prev: LedgerRefs | undefined, next: LedgerRefs | undefined): LedgerRefs {
  return {
    runs: { ...prev?.runs, ...next?.runs },
    orders: { ...prev?.orders, ...next?.orders },
  };
}
