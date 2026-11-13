// 探索首页的纯逻辑:链接拼装、市场筛选与排序、工作状态文案。界面组件只管渲染。

import type { WorkStatus } from "@/lib/modules/session/domain/recent-work";

/** 智能体设计器新建页:把用户说的那件事带过去(阶段 4/5 的新建页接住 desc)。 */
export function designerHref(desc: string): string {
  const text = desc.trim();
  return text ? `/agents/new?desc=${encodeURIComponent(text)}` : "/agents/new";
}

/** 带附件「用设计器创建」:设计会话已建好、附件已传进它的工作区,直接进构建页新建态自动发送 */
export function designerSessionHref(sessionId: string, desc: string, files: string[]): string {
  const q = [
    `designer=${encodeURIComponent(sessionId)}`,
    `desc=${encodeURIComponent(desc.trim())}`,
  ];
  for (const f of files) q.push(`file=${encodeURIComponent(f)}`);
  return `/agents/new?${q.join("&")}`;
}

/** 打开新建的会话;带上示例问题时用 q 参数预填进对话页输入框(只预填,不自动发送) */
export function chatHref(sessionId: string, question?: string): string {
  const base = `/chat?session=${encodeURIComponent(sessionId)}`;
  return question ? `${base}&q=${encodeURIComponent(question)}` : base;
}

/** 「立即使用」建好会话后的提示:已用「X」vN 新建会话。 */
export function startedText(name?: string | null, version?: number | null): string {
  if (!name) return "已新建会话";
  return `已用「${name}」${version ? `v${version} ` : ""}新建会话`;
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
