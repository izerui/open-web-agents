// 管理员按邮箱批量发放积分:解析粘贴的邮箱清单。纯函数。

/** 一次最多发放的邮箱数 */
export const MAX_BATCH_EMAILS = 200;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedEmail =
  | { email: string; status: "ok" }
  | { email: string; status: "invalid" | "duplicate" };

/**
 * 按换行、逗号、分号、空白拆分;去掉首尾空白并转小写(账号邮箱统一小写存取)。
 * 重复的只保留第一次,其余标 duplicate;格式不对的标 invalid。空清单或超过上限抛错。
 */
export function parseEmailList(text: string): ParsedEmail[] {
  const raw = text
    .split(/[\s,;，；]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (raw.length === 0) throw new Error("请至少填写一个邮箱");
  if (raw.length > MAX_BATCH_EMAILS) {
    throw new Error(`一次最多 ${MAX_BATCH_EMAILS} 个邮箱,当前 ${raw.length} 个`);
  }
  const seen = new Set<string>();
  return raw.map((email): ParsedEmail => {
    if (!EMAIL.test(email) || email.length > 254) return { email, status: "invalid" };
    if (seen.has(email)) return { email, status: "duplicate" };
    seen.add(email);
    return { email, status: "ok" };
  });
}
