// 审计事件的种类与脱敏规则。纯逻辑。
//
// 【为什么要有审计】智能体被企业系统当接口用之后,"谁在什么时候改了提示词、发布了哪一版、
// 签发 / 吊销了哪把 Key、批准了哪个危险操作"都需要事后说得清。

export const AUDIT_ACTIONS = [
  "agent.create",
  "agent.update",
  "agent.delete",
  "agent.publish",
  "agent.activate_version",
  "agent.restore_version",
  "agent.share",
  "agent.unshare",
  "knowledge.add",
  "knowledge.delete",
  "knowledge.update",
  "api_key.issue",
  "api_key.revoke",
  "api_key.rotate",
  "api_key.rate_limit",
  "api_key.monthly_limit",
  "approval.decide",
  "approval.revoke_grant",
  "account.create",
  "account.update",
  "account.reset_password",
  "auth.register",
  "auth.login",
  "auth.login_failed",
  "me.password_change",
  "me.credentials_update",
  "me.webhook_secret_set",
  "me.webhook_secret_clear",
  "group.create",
  "group.member_add",
  "group.member_remove",
  "webhook.test",
  "webhook.redeliver",
  "eval.run",
  "capability.update",
  "provider.create",
  "provider.update",
  "provider.key_replace",
  "provider.test",
  "model.update",
  "model.alias_update",
  "agent.clone",
  "billing.credit",
  "billing.mode_update",
  "billing.package_update",
  "billing.order_create",
  "billing.order_cancel",
  "billing.order_confirm",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(v: string): v is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(v);
}

/** 字段名像机密的一律打码 —— 调用方漏处理时的最后一道防线。 */
const SECRET_NAME =
  /(^|_|-)?(key|secret|password|passwd|token|authorization|cookie|env|credential|plaintext|prompt)s?$/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 50;

/**
 * 审计细节脱敏:机密字段打码、长字符串截断、深度与条数封顶。
 *
 * 规则是"按字段名打码",所以调用方仍应只放必要的信息(例如智能体修改只记改了哪些字段名,
 * 不记新值)。这里兜住的是"顺手把整个请求体塞进来"这类疏忽。
 */
export function sanitizeDetails(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => sanitizeDetails(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ITEMS)) {
    // agentId / keyId 这类"某某 id"不是机密
    out[k] = SECRET_NAME.test(k) && !/id$/i.test(k) ? "***" : sanitizeDetails(x, depth + 1);
  }
  return out;
}

/** 两份配置之间改了哪些顶层字段(只给字段名,不给值 —— 提示词、MCP 配置都可能含敏感内容)。 */
export function changedFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((k) => stable(before?.[k]) !== stable(after[k])).sort();
}

/** 键排序后的 JSON:字段顺序不同不算修改。 */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
    .join(",")}}`;
}
