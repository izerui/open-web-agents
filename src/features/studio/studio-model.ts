import type { AgentSummary } from "@/features/workbench/types";

/**
 * 工作室(我的智能体)的纯逻辑:分组、徽标、筛选、ID 校验、删除资格、时间文案、空白创建的请求体。
 * 组件只负责摆放;这里的判断都有单测(src/features/studio/__tests__)。
 */

/** GET /api/agents 的一项(工作室用到的字段) */
export type StudioAgent = AgentSummary & {
  config: AgentSummary["config"] & Record<string, unknown>;
  /** 调用方是不是所有者(服务端判定) */
  isOwner?: boolean;
  /** 近 7 天运行数 */
  runs7d?: number;
  /** 草稿最后修改时间(ms) */
  updatedAt?: number | null;
  /** 是否已上架市场 */
  marketListed?: boolean;
};

export type StudioTab = "mine" | "shared" | "all";

/** 新建弹层的四种方式:智能体设计器 / 空白 / 从市场克隆 / 模板库 */
export type NewMode = "ai" | "blank" | "clone" | "tpl";
export const NEW_MODES: readonly NewMode[] = ["ai", "blank", "clone", "tpl"];
export type StudioKind = "mine" | "shared" | "builtin";

/**
 * 平台内置、不能删除的智能体(与 DELETE /api/agents/{id} 的判定一致)。
 * 本地写常量而不是引 agent/domain:那里带着整段设计师提示词,不该进前端包(Builder 同样如此)。
 */
export const BUILT_IN_AGENT_IDS: readonly string[] = ["default", "agent-architect"];

export function studioKind(a: StudioAgent): StudioKind {
  if (BUILT_IN_AGENT_IDS.includes(a.id)) return "builtin";
  return a.isOwner ? "mine" : "shared";
}

/** 列表视图「来源」列;所有者是谁不在接口里(不向别人暴露账号),只说明怎么来的 */
export function studioSource(a: StudioAgent): string {
  const kind = studioKind(a);
  if (kind === "builtin") return "平台内置";
  if (kind === "mine") return "我建的";
  return a.isPublic ? "公开" : "分享给我的";
}

/** 只有市场使用权的条目不是「我的」智能体(Builder 列表同样排除) */
export function studioAgents(list: StudioAgent[]): StudioAgent[] {
  return list.filter((a) => a.canRead !== false);
}

export type BadgeKind =
  | "published"
  | "changed"
  | "draft"
  | "builtin"
  | "read"
  | "write"
  | "market"
  | "api";
export interface StudioBadge {
  kind: BadgeKind;
  label: string;
  variant: "success" | "warning" | "default" | "dark" | "outline";
  title?: string;
}

export function studioBadges(a: StudioAgent): StudioBadge[] {
  const out: StudioBadge[] = [];
  const kind = studioKind(a);
  if (kind === "builtin") out.push({ kind: "builtin", label: "内置", variant: "dark" });
  if (kind === "shared") {
    out.push(
      a.canWrite === false
        ? { kind: "read", label: "只读", variant: "outline", title: "只能查看和使用发布版" }
        : { kind: "write", label: "可编辑", variant: "outline", title: "所有者给了你编辑权限" },
    );
  } else if (a.publishedVersion) {
    out.push({ kind: "published", label: `已发布 v${a.publishedVersion}`, variant: "success" });
    if (a.canWrite !== false && a.hasUnpublishedChanges) {
      out.push({
        kind: "changed",
        label: "草稿有修改",
        variant: "warning",
        title: "草稿有未发布的修改;接口调用和其他用户仍在用发布版",
      });
    }
  } else {
    out.push({ kind: "draft", label: "未发布", variant: "default", title: "调用方直接用草稿" });
  }
  if (a.marketListed) out.push({ kind: "market", label: "已上架", variant: "outline" });
  if (a.config.outputSchema) {
    out.push({
      kind: "api",
      label: "接口",
      variant: "outline",
      title: "声明了输出契约,可当接口调用",
    });
  }
  return out;
}

export function filterStudio(list: StudioAgent[], tab: StudioTab, q: string): StudioAgent[] {
  const query = q.trim().toLowerCase();
  return list.filter(
    (a) =>
      (tab === "all" || studioKind(a) === tab) &&
      (!query || `${a.name}\n${a.id}\n${a.description ?? ""}`.toLowerCase().includes(query)),
  );
}

export function studioCounts(list: StudioAgent[]): Record<StudioTab, number> {
  return {
    mine: list.filter((a) => studioKind(a) === "mine").length,
    shared: list.filter((a) => studioKind(a) === "shared").length,
    all: list.length,
  };
}

/** 数据库里 id 是 varchar(36);小写字母、数字、短横线,首字符不能是短横线 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,35}$/;

/** 新建时的 ID 校验;留空合法(自动生成)。返回错误文案或 null。 */
export function validateNewAgentId(id: string, taken: readonly string[]): string | null {
  const v = id.trim();
  if (!v) return null;
  if (!ID_PATTERN.test(v)) return "ID 只能用小写字母、数字和短横线，2 到 36 位，不能以短横线开头";
  if (taken.includes(v)) return "ID 已被占用";
  return null;
}

/**
 * 不能删除的原因;能删返回 null。
 * 所有者或管理员才能删 —— 与 Builder 同一个判定(canManageWebhook 就是「所有者或管理员」)。
 */
export function deleteBlock(a: StudioAgent): string | null {
  if (BUILT_IN_AGENT_IDS.includes(a.id)) return "内置智能体不能删除";
  if (!a.canManageWebhook) return "只有所有者或管理员可以删除";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatUpdated(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return "昨天";
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/**
 * 空白创建的请求体。
 *
 * 系统提示词是必填(保存时后端校验),但空白创建的弹层只问名称 —— 先给一段占位提示词,
 * 让草稿立刻能建出来、能试聊;进入构建页后再改成真正的规则。
 */
export function blankCreateBody(input: {
  name: string;
  id: string;
  description: string;
  icon: string;
}) {
  const name = input.name.trim();
  const id = input.id.trim();
  const description = input.description.trim();
  const systemPrompt = [
    `# 角色\n你是「${name}」。${description ? `\n${description}` : ""}`,
    "# 规则\n（空白创建时生成的占位提示词：请在编排里写清楚它要做什么、遵守哪些规则、交付什么。）",
  ].join("\n\n");
  return {
    ...(id ? { id } : {}),
    name,
    ...(description ? { description } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    createOnly: true as const,
    config: { systemPrompt },
  };
}
