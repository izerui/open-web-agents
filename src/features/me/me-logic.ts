// 「我的」页(手机聚合页)的纯逻辑:入口清单、入口右侧的附加信息。
import { BarChart3, List, Lock, type LucideIcon, ReceiptText, ScrollText, Tag } from "lucide-react";

export type MeRow = { href: string; label: string; icon: LucideIcon };

/** 「我的订单」直达积分与套餐 → 充值与订单页签里的订单表(view=orders) */
export const ORDERS_HREF = "/account/billing?tab=packages&view=orders";

/** 原型「我的」页的六个入口。本地模式(匿名管理员)没有积分账户和密码,去掉订单、流水、账号安全 */
export function meAccountRows(local: boolean): MeRow[] {
  const rows: (MeRow & { account?: true })[] = [
    { href: ORDERS_HREF, label: "我的订单", icon: ReceiptText, account: true },
    { href: "/account/billing?tab=ledger", label: "积分流水", icon: List, account: true },
    { href: "/account/usage", label: "用量", icon: BarChart3 },
    { href: "/account/prices", label: "模型价格", icon: Tag },
    { href: "/account/security", label: "账号安全", icon: Lock, account: true },
    { href: "/account/audit", label: "操作日志", icon: ScrollText },
  ];
  return rows.filter((r) => !local || !r.account).map(({ account: _, ...r }) => r);
}

/** 「我的订单」右边:有待人工处理的订单时写「N 个待处理」 */
export function pendingOrdersHint(orders: readonly { status: string }[]): string {
  const n = orders.filter((o) => o.status === "pending").length;
  return n ? `${n} 个待处理` : "";
}

/** 「用量」右边:近 7 天运行次数;记录超过单次查询上限(truncated)时加「+」 */
export function recentRunsHint(totals: { runs: number } | undefined, truncated = false): string {
  if (!totals?.runs) return "";
  return `近 7 天 ${totals.runs.toLocaleString("en-US")}${truncated ? "+" : ""} 次`;
}
