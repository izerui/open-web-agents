// 探索首页的纯逻辑:链接拼装、市场筛选与排序、工作状态文案。界面组件只管渲染。

import type { WorkStatus } from "@/lib/modules/session/domain/recent-work";

/** 智能体设计器新建页:把用户说的那件事带过去(阶段 4/5 的新建页接住 desc)。 */
export function designerHref(desc: string): string {
  const text = desc.trim();
  return text ? `/agents/new?desc=${encodeURIComponent(text)}` : "/agents/new";
}

/**
 * 对话页还不认 q 参数(阶段 3 再接):现在只打开新建的会话,不把问题带过去。
 * 对话页支持后把它改成 true,示例问题就会直接带进输入框。
 */
export const CHAT_ACCEPTS_Q = false;

export function chatHref(sessionId: string, question?: string): string {
  const base = `/chat?session=${encodeURIComponent(sessionId)}`;
  return CHAT_ACCEPTS_Q && question ? `${base}&q=${encodeURIComponent(question)}` : base;
}

export interface MarketListItem {
  id: string;
  name: string;
  description?: string | null;
  category: string;
  useCount: number;
  publishedAt: number | null;
}

export function filterMarket<T extends MarketListItem>(
  items: readonly T[],
  query: { category: string; search: string },
): T[] {
  const term = query.search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!query.category || item.category === query.category) &&
      (!term || `${item.name}\n${item.description ?? ""}`.toLocaleLowerCase().includes(term)),
  );
}

export type MarketSort = "hot" | "new";

export function sortMarket<T extends MarketListItem>(items: readonly T[], sort: MarketSort): T[] {
  return [...items].sort((a, b) =>
    sort === "hot"
      ? b.useCount - a.useCount || a.name.localeCompare(b.name)
      : (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || a.name.localeCompare(b.name),
  );
}

export type Tone = "success" | "warning" | "destructive" | "muted";

const LABELS: Record<WorkStatus, { label: string; tone: Tone }> = {
  running: { label: "正在工作", tone: "warning" },
  delivered: { label: "成果已交付", tone: "success" },
  replied: { label: "已回复", tone: "success" },
  failed: { label: "失败", tone: "destructive" },
  cancelled: { label: "已停止", tone: "muted" },
  idle: { label: "还没开始", tone: "muted" },
};

export function workStatusLabel(status: WorkStatus): { label: string; tone: Tone } {
  return LABELS[status];
}
