/**
 * 对话正文里外链的确认框（chat N1）：Streamdown 自带的确认框是英文、画在对话流里，
 * 这里只放确认框要用的纯逻辑；弹框本身在 external-link-dialog.tsx。
 */

const MAX_SHOWN = 60;

/** 确认框里写「将要打开 X」的 X：http(s) 只给域名（含端口），mailto 给邮箱，其他给原地址（过长截断）。 */
export function externalLinkTarget(url: string): string {
  const raw = url.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host;
    if (parsed.protocol === "mailto:") return decodeURIComponent(parsed.pathname);
  } catch {
    // 不是合法地址，按原文显示
  }
  return raw.length > MAX_SHOWN ? `${raw.slice(0, MAX_SHOWN)}…` : raw;
}
