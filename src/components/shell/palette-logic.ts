// ⌘K 面板里智能体与会话的显示文案(纯函数,便于单测)。

import { BUILT_IN_AGENT_IDS } from "@/features/studio/studio-model";

/**
 * 智能体右侧的状态:内置的写「内置」,别人分享来的写「分享」(公开的写「公开」),
 * 自己的写发布状态。内置和分享来的不是你在改的草稿,一律写「草稿」会误导。
 */
export function agentStatusText(a: {
  id?: string;
  isOwner?: boolean;
  isPublic?: boolean;
  publishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
}): string {
  if (a.id && BUILT_IN_AGENT_IDS.includes(a.id)) return "内置";
  if (a.isOwner === false) return a.isPublic ? "公开" : "分享";
  if (!a.publishedVersion) return "草稿";
  return a.hasUnpublishedChanges
    ? `v${a.publishedVersion} · 有改动未发布`
    : `已发布 v${a.publishedVersion}`;
}

/** 没标题的会话用「新对话 · 时间」兜底;实现挪到 src/lib 与对话页共用 */
export { sessionTitle } from "@/lib/session-title";

/** 会话右侧显示轮数 */
export function sessionMeta(s: { runCount?: number }): string {
  return s.runCount ? `${s.runCount} 轮` : "还没开始";
}

/** ⌘K 没输入时智能体组只列这么多条,其余去工作室看 */
export const PALETTE_AGENT_LIMIT = 8;

/** 智能体组要画哪些:没输入时截前 8 条(more = 还有更多);输入了搜索词时全部交给面板过滤 */
export function paletteAgents<T>(
  agents: readonly T[],
  query: string,
): { shown: T[]; more: boolean } {
  if (query.trim()) return { shown: [...agents], more: false };
  return {
    shown: agents.slice(0, PALETTE_AGENT_LIMIT),
    more: agents.length > PALETTE_AGENT_LIMIT,
  };
}
