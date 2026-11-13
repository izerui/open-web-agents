// ⌘K 面板里智能体与会话的显示文案(纯函数,便于单测)。

/** 智能体右侧的发布状态 */
export function agentStatusText(a: {
  publishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
}): string {
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
