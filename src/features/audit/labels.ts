// 审计记录的中文展示:动作名称 + 一句话描述。纯函数,便于测试。

import type { AuditAction } from "@/lib/modules/audit/domain/events";

/** Record<AuditAction, …>:新增动作忘了配中文名,编译期就会报错。 */
export const ACTION_LABEL: Record<AuditAction, string> = {
  "agent.create": "创建智能体",
  "agent.update": "修改智能体",
  "agent.publish": "发布版本",
  "agent.activate_version": "切换发布版本",
  "agent.restore_version": "载入版本到草稿",
  "agent.share": "分享智能体",
  "agent.unshare": "撤销分享",
  "knowledge.add": "添加知识文档",
  "knowledge.delete": "删除知识文档",
  "api_key.issue": "签发 API Key",
  "api_key.revoke": "吊销 API Key",
  "api_key.rate_limit": "调整 Key 限额",
  "approval.decide": "审批",
  "account.create": "创建账号",
  "account.update": "修改账号",
  "account.reset_password": "重置密码",
  "auth.register": "注册",
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "me.password_change": "修改密码",
  "me.credentials_update": "修改模型凭证",
  "me.webhook_secret_set": "设置回调签名密钥",
  "me.webhook_secret_clear": "清除回调签名密钥",
  "group.create": "创建用户组",
  "group.member_add": "添加组成员",
  "group.member_remove": "移除组成员",
};

/** 需要特别留意的动作:界面上用醒目颜色标出。 */
export const SENSITIVE: ReadonlySet<string> = new Set([
  "auth.login_failed",
  "approval.decide",
  "account.reset_password",
  "account.update",
  "api_key.issue",
  "agent.activate_version",
  "agent.share",
]);

export interface AuditItem {
  id: string;
  at: number;
  actor: { type: "user" | "apiKey" | "anonymous"; id?: string; label?: string };
  action: string;
  resource: { type: string; id?: string };
  details?: Record<string, unknown>;
  ip?: string;
}

export function actionLabel(action: string): string {
  return (ACTION_LABEL as Record<string, string>)[action] ?? action;
}

export function actorLabel(a: AuditItem["actor"]): string {
  if (a.type === "anonymous") return "未登录";
  return a.label ?? (a.type === "apiKey" ? `Key ${a.id ?? ""}` : (a.id ?? "未知"));
}

const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** 一句话说明这次操作做了什么。 */
export function describeAudit(e: AuditItem): string {
  const d = e.details ?? {};
  switch (e.action) {
    case "agent.create":
    case "agent.update": {
      const changed = Array.isArray(d.changed) ? (d.changed as string[]) : [];
      const via = d.via === "designer" ? "(通过 AI 设计师)" : "";
      return `「${s(d.name)}」${via}${changed.length ? `:改动 ${changed.join("、")}` : ""}`;
    }
    case "agent.publish":
      return `发布 v${s(d.version)}${d.note ? `:${s(d.note)}` : ""}`;
    case "agent.activate_version":
      return `发布版本 ${d.from ? `v${s(d.from)}` : "无"} → v${s(d.to)}`;
    case "agent.restore_version":
      return `把 v${s(d.version)} 载入草稿`;
    case "agent.share":
      return `分享给 ${s(d.target)}(${d.permission === "write" ? "可编辑" : "只读"})`;
    case "agent.unshare":
      return `撤销对 ${s(d.principalId) || "?"} 的分享`;
    case "knowledge.add":
    case "knowledge.delete":
      return `「${s(d.title)}」`;
    case "api_key.issue":
      return `「${s(d.name) || "未命名"}」${
        d.boundAgentId ? `,仅限智能体「${s(d.boundAgentName) || s(d.boundAgentId)}」` : ""
      }`;
    case "api_key.revoke":
      return `「${s(d.name) || "未命名"}」`;
    case "api_key.rate_limit":
      return `「${s(d.name) || "未命名"}」每分钟上限 ${d.from ?? "默认"} → ${d.to ?? "默认"}`;
    case "approval.decide":
      return `${d.decision === "approved" ? "批准" : "拒绝"} ${s(d.tool)}${d.summary ? `:${s(d.summary)}` : ""}`;
    case "account.create":
      return `${s(d.email)}(${s(d.role)})`;
    case "account.update": {
      const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const parts = Object.entries(changes).map(
        ([k, v]) => `${k}: ${String(v.from)} → ${String(v.to)}`,
      );
      return `${s(d.email)}${parts.length ? `:${parts.join(",")}` : ""}`;
    }
    case "account.reset_password":
      return s(d.email);
    case "auth.login_failed":
      return `${s(d.email)}:${s(d.reason)}`;
    case "me.credentials_update":
      return `Base URL ${s(d.baseUrl)},模型 Key ${s(d.modelKey)}`;
    case "group.create":
      return `「${s(d.name)}」`;
    case "group.member_add":
      return `「${s(d.group)}」加入 ${s(d.email)}`;
    case "group.member_remove":
      return `「${s(d.group)}」移除 ${s(d.memberId)}`;
    default:
      return "";
  }
}
