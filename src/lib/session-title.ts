import { formatTime } from "@/lib/format-time";

/**
 * 会话在界面上的名字:有标题用标题,没标题用「新对话 · MM-DD HH:mm」兜底 —— 一串 ID 对用户没有意义。
 * ⌘K 面板与对话页左栏、对话头等共用,同一个会话在各处长得一样。
 */
export function sessionTitle(
  s: { title?: string | null; createdAt?: number },
  now: number = Date.now(),
): string {
  const title = s.title?.trim();
  if (title) return title;
  return s.createdAt ? `新对话 · ${formatTime(s.createdAt, now)}` : "新对话";
}
