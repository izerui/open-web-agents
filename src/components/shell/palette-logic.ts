// ⌘K 面板里智能体与会话的显示文案(纯函数,便于单测)。

import { formatTime } from "@/lib/format-time";

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

/** 没标题的会话用「新对话 · 时间」兜底;一串 ID 对用户没有意义 */
export function sessionTitle(
  s: { title?: string | null; createdAt?: number },
  now: number = Date.now(),
): string {
  const title = s.title?.trim();
  if (title) return title;
  return s.createdAt ? `新对话 · ${formatTime(s.createdAt, now)}` : "新对话";
}

/** 会话右侧显示轮数 */
export function sessionMeta(s: { runCount?: number }): string {
  return s.runCount ? `${s.runCount} 轮` : "还没开始";
}
