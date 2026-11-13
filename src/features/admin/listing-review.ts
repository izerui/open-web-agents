// 上架审核(管理端「市场上架 · 上架申请」)的纯逻辑:默认类别与申请卡上的类别标签。

import { MARKET_CATEGORIES, validCategory } from "@/lib/modules/market/domain/catalog";

type Categories = { requestedCategory?: string | null; agentCategory?: string | null };

const nameOf = (id: string) => MARKET_CATEGORIES.find((c) => c.id === id)?.name ?? id;

/** 审核下拉的默认值:申请里的类别 → 智能体当前类别 → 通用助手 */
export function reviewCategory(r: Categories): string {
  for (const c of [r.requestedCategory, r.agentCategory]) if (validCategory(c)) return c;
  return "general";
}

/** 申请卡上的类别标签;旧申请没有申请类别时写明显示的是智能体当前类别 */
export function categoryLabel(r: Categories): string {
  if (validCategory(r.requestedCategory)) return `申请类别：${nameOf(r.requestedCategory)}`;
  if (validCategory(r.agentCategory)) return `当前类别：${nameOf(r.agentCategory)}`;
  return "申请类别：未选";
}
