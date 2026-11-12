// 构建页「档案」的纯逻辑:表单草稿 ↔ 智能体配置、自动保存的闸门、九节的摘要与是否已填、高级参数。
// 组件只负责摆放;这里的判断都有单测(src/features/build/__tests__/profile-model.test.ts)。

import { PERMISSION_MODES, type PermissionMode } from "@/lib/shared";
import { findPathConflict, isSafeSkillPath } from "@/lib/shared/skill-package";

export type SectionKey =
  | "identity"
  | "prompt"
  | "model"
  | "ability"
  | "knowledge"
  | "vars"
  | "contract"
  | "approval"
  | "webhook";

export const SECTIONS: readonly { key: SectionKey; title: string }[] = [
  { key: "identity", title: "名称与头像" },
  { key: "prompt", title: "提示词" },
  { key: "model", title: "模型" },
  { key: "ability", title: "能力" },
  { key: "knowledge", title: "知识" },
  { key: "vars", title: "变量与密钥" },
  { key: "contract", title: "输入输出契约" },
  { key: "approval", title: "审批与权限" },
  { key: "webhook", title: "Webhook" },
];

export type EffortValue = "" | "low" | "medium" | "high";
export const EFFORTS: readonly [EffortValue, string][] = [
  ["", "跟随模型默认"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
];

/**
 * 权限模式的中文名与用法(名字对齐 Claude 官方客户端的菜单)。
 * 直接把 default、dontAsk 这种 SDK 内部值摆给用户看,没人知道该选哪个。
 */
export const PERMISSION_META: Record<PermissionMode, { label: string; hint: string }> = {
  default: { label: "询问权限", hint: "有人盯着的网页对话：命中审批规则时弹确认" },
  acceptEdits: { label: "自动接受编辑", hint: "文件改动自动放行，其余照常询问" },
  plan: { label: "规划模式", hint: "只探索和出方案，不动源文件" },
  auto: { label: "自动判定", hint: "由模型分类器逐个判定（需要特定配置支持）" },
  bypassPermissions: {
    label: "跳过权限检查",
    hint: "接口调用等无人值守场景：不问人。路径围栏与工具白名单仍然生效",
  },
  dontAsk: { label: "从不询问", hint: "白名单之外一律拒绝，不弹任何确认" },
};

export const UNATTENDED: readonly ["" | "allow" | "deny", string, string][] = [
  ["", "按入口默认", "接口调用放行；网页对话始终等人审批"],
  ["deny", "一律拒绝", "没有审批人时，命中审批规则的操作全部拒绝（更安全）"],
  ["allow", "一律放行", "没有审批人时，命中审批规则的操作全部放行"],
];

export interface McpDraft {
  /** 稳定行 id。用数组索引作 key 会在删除中间行时把编辑状态错位到别行。 */
  uid: string;
  name: string;
  type: "http" | "stdio";
  url: string;
  command: string;
  /** 每行一个参数,避免用空格拆分时破坏带空格的单个参数。 */
  argsText: string;
  /** JSON 字符串对象。env 常含 URL、token 等不能可靠按分隔符拆。 */
  envText: string;
}

export interface SubagentDraft {
  uid: string;
  name: string;
  /** 何时用它 —— 主 agent 靠这句话决定要不要把子任务交出去 */
  description: string;
  prompt: string;
  /** 模型;空 = 与主 agent 相同 */
  model: string;
}

export interface SkillDraft {
  uid: string;
  name: string;
  description: string;
  files: Record<string, string>;
}

export interface VariableDraft {
  uid: string;
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

export interface ProfileDraft {
  id: string;
  name: string;
  description: string;
  /** 头像(avatar:#色:眼睛);空 = 按 id 算 */
  icon: string;
  /** 开场建议,一行一条 */
  startersText: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  effort: EffortValue;
  inputSchemaText: string;
  outputSchemaText: string;
  webhookUrl: string;
  /** 工具白名单(逗号分隔);留空 = 不限制 */
  toolsText: string;
  skillPackages: SkillDraft[];
  mcpServers: McpDraft[];
  subagents: SubagentDraft[];
  approvalToolsText: string;
  approvalPatternsText: string;
  permissionMode: PermissionMode;
  /** 没有审批人时(接口调用)命中审批规则怎么办;空 = 按入口默认 */
  unattendedApproval: "" | "allow" | "deny";
  variables: VariableDraft[];
  /** 表单没有的配置参数(如 approvalRules.all),JSON 对象文本;空 = 没有 */
  advancedText: string;
}

export const EMPTY_DRAFT: ProfileDraft = {
  id: "",
  name: "",
  description: "",
  icon: "",
  startersText: "",
  systemPrompt: "",
  model: "sonnet",
  maxTurns: 20,
  effort: "",
  inputSchemaText: "",
  outputSchemaText: "",
  webhookUrl: "",
  toolsText: "",
  skillPackages: [],
  mcpServers: [],
  subagents: [],
  approvalToolsText: "",
  approvalPatternsText: "",
  permissionMode: "default",
  unattendedApproval: "",
  variables: [],
  advancedText: "",
};

/** GET /api/agents 的一项里构建页用到的部分 */
export interface LoadedAgent {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  webhookUrl?: string;
  config: Record<string, unknown>;
}

/** 表单逐字段管理的配置键;其余(除逃生舱与旧 skills)进「高级参数」 */
const FORM_KEYS = [
  "systemPrompt",
  "model",
  "maxTurns",
  "effort",
  "inputSchema",
  "outputSchema",
  "tools",
  "skillPackages",
  "mcpServers",
  "subagents",
  "variables",
  "permissionMode",
  "unattendedApproval",
  "starters",
  "approvalRules",
];
/** 设计器与这里都不允许改的字段(name/description 不在配置里,也一并拦下) */
export const PARAM_BAN = [
  "name",
  "description",
  "systemPrompt",
  "skills",
  "skillPackages",
  "mcpServers",
  "escapeHatch",
];
const HIDDEN_KEYS = ["escapeHatch", "skills"];

const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 技能名、工具名按逗号/换行/空格拆分,去空去重 —— 用户怎么贴都能用 */
export function splitNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，\s\n]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export function draftFromAgent(
  a: LoadedAgent,
  uid: () => string = () => crypto.randomUUID(),
): ProfileDraft {
  const cfg = a.config;
  const rules = isObj(cfg.approvalRules) ? cfg.approvalRules : {};
  const effort = cfg.effort;
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? "",
    icon: a.icon ?? "",
    startersText: arr<string>(cfg.starters).join("\n"),
    systemPrompt: str(cfg.systemPrompt),
    model: str(cfg.model) || "sonnet",
    maxTurns: Number(cfg.maxTurns ?? 20) || 20,
    effort: effort === "low" || effort === "medium" || effort === "high" ? effort : "",
    inputSchemaText: isObj(cfg.inputSchema) ? JSON.stringify(cfg.inputSchema, null, 2) : "",
    outputSchemaText: isObj(cfg.outputSchema) ? JSON.stringify(cfg.outputSchema, null, 2) : "",
    webhookUrl: a.webhookUrl ?? "",
    toolsText: arr<{ name?: string }>(cfg.tools)
      .map((t) => t?.name ?? "")
      .filter(Boolean)
      .join(", "),
    skillPackages: arr<{ name?: string; description?: string; files?: Record<string, string> }>(
      cfg.skillPackages,
    ).map((k) => ({
      uid: uid(),
      name: k.name ?? "",
      description: k.description ?? "",
      files: k.files ?? { "SKILL.md": "" },
    })),
    mcpServers: arr<{
      name?: string;
      type?: string;
      url?: string;
      command?: string;
      args?: unknown;
      env?: unknown;
    }>(cfg.mcpServers).map((m) => ({
      uid: uid(),
      name: m.name ?? "",
      type: m.type === "stdio" ? "stdio" : "http",
      url: m.url ?? "",
      command: m.command ?? "",
      argsText: Array.isArray(m.args) ? m.args.join("\n") : "",
      envText: isObj(m.env) ? JSON.stringify(m.env, null, 2) : "",
    })),
    subagents: arr<{ name?: string; description?: string; prompt?: string; model?: string }>(
      cfg.subagents,
    ).map((s) => ({
      uid: uid(),
      name: s.name ?? "",
      description: s.description ?? "",
      prompt: s.prompt ?? "",
      model: s.model ?? "",
    })),
    approvalToolsText: arr<string>(rules.tools).join(", "),
    approvalPatternsText: arr<string>(rules.commandPatterns).join(", "),
    // 存的是历史值时可能是个已废弃/写错的模式,回落到 default 而不是把界面搞崩
    permissionMode: PERMISSION_MODES.includes(cfg.permissionMode as PermissionMode)
      ? (cfg.permissionMode as PermissionMode)
      : "default",
    unattendedApproval:
      cfg.unattendedApproval === "allow" || cfg.unattendedApproval === "deny"
        ? cfg.unattendedApproval
        : "",
    variables: arr<{ name?: string; description?: string; required?: boolean; secret?: boolean }>(
      cfg.variables,
    ).map((v) => ({
      uid: uid(),
      name: v.name ?? "",
      description: v.description ?? "",
      required: v.required === true,
      secret: v.secret === true,
    })),
    advancedText: advancedOf(cfg),
  };
}

/**
 * 以已加载的配置为底,覆盖表单管理的字段。表单字段值为 undefined 表示"清空",要真的删掉 ——
 * 直接展开的话 JSON 会丢掉 undefined 键,底下的旧值就又冒出来了。
 */
export function overlayConfig(
  base: Record<string, unknown>,
  form: Record<string, unknown>,
): Record<string, unknown> {
  const cleared = new Set(Object.keys(form).filter((k) => form[k] === undefined));
  // 旧版"技能名"字段从未生效;表单已改用技能包,不再回写它
  cleared.add("skills");
  return Object.fromEntries(Object.entries({ ...base, ...form }).filter(([k]) => !cleared.has(k)));
}

/** 构建器里的一行 MCP → 配置;保存与测试连接共用。env 不是字符串键值 JSON 时抛错 */
export function mcpOfRow(m: McpDraft) {
  if (m.type === "http") return { name: m.name.trim(), type: "http" as const, url: m.url.trim() };
  let env: Record<string, string> | undefined;
  if (m.envText.trim()) {
    const parsed = JSON.parse(m.envText) as unknown;
    if (!isObj(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) {
      throw new Error(`MCP「${m.name || "未命名"}」的 env 必须是字符串键值 JSON 对象`);
    }
    env = parsed as Record<string, string>;
  }
  return {
    name: m.name.trim(),
    type: "stdio" as const,
    command: m.command.trim(),
    args: m.argsText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    env,
  };
}

/** env 文本的错误;合法或为空返回空串 */
export function envError(text: string): string {
  if (!text.trim()) return "";
  try {
    const j = JSON.parse(text) as unknown;
    if (!isObj(j)) return "env 必须是 JSON 对象";
    if (Object.values(j).some((v) => typeof v !== "string")) return "env 的值必须都是字符串";
    return "";
  } catch {
    return "env 不是合法 JSON";
  }
}

export type SchemaParse =
  | { ok: true; empty: true }
  | { ok: true; empty?: false; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseSchemaText(text: string): SchemaParse {
  if (!text.trim()) return { ok: true, empty: true };
  try {
    const v = JSON.parse(text) as unknown;
    if (!isObj(v)) return { ok: false, error: "顶层必须是 JSON 对象" };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" };
  }
}

/** 表单没有的参数:approvalRules.all 与不认识的键(逃生舱、旧 skills 不显示) */
export function advancedOf(cfg: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (FORM_KEYS.includes(k) || HIDDEN_KEYS.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  const rules = cfg.approvalRules;
  if (isObj(rules) && rules.all !== undefined) out.approvalRules = { all: rules.all };
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : "";
}

/** 高级参数文本的错误;合法(含空)返回 null */
export function advancedError(text: string): string | null {
  if (!text.trim()) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return "不是合法 JSON";
  }
  if (!isObj(j)) return "顶层必须是 JSON 对象";
  const keys = Object.keys(j);
  const banned = keys.filter((k) => PARAM_BAN.includes(k));
  if (banned.length) {
    return banned.includes("escapeHatch")
      ? `不能包含 ${banned.join("、")}(逃生舱不允许在这里改)`
      : `不能包含 ${banned.join("、")},请在对应的节里改`;
  }
  const managed = keys.filter((k) => FORM_KEYS.includes(k) && k !== "approvalRules");
  if (managed.length) return `${managed.join("、")} 请在对应的节里改`;
  if ("approvalRules" in j) {
    const r = j.approvalRules;
    if (!isObj(r) || Object.keys(r).some((k) => k !== "all")) return "approvalRules 这里只能写 all";
  }
  return null;
}

/** 列表清空时:原来是空数组就保留空数组,原来没有就不写 —— 免得一次保存凭空多出改动 */
function emptyList(base: unknown): [] | undefined {
  return Array.isArray(base) && base.length === 0 ? [] : undefined;
}

export interface SaveBody {
  id?: string;
  name: string;
  description?: string;
  icon?: string;
  webhookUrl?: string;
  config: Record<string, unknown>;
  createOnly?: boolean;
}

/**
 * 自动保存的请求体(POST /api/agents)。
 * 以已加载的完整配置为底、只覆盖表单管理的字段 —— 表单不认识的字段(设计器写入的新字段……)原样保留。
 * 调用前须先过 saveBlock(这里假定 Schema、env、高级参数都合法)。
 */
export function saveBodyOf(
  d: ProfileDraft,
  opts: { loadedConfig: Record<string, unknown>; canManageWebhook: boolean; isNew: boolean },
): SaveBody {
  const base = opts.loadedConfig;
  const input = parseSchemaText(d.inputSchemaText);
  const output = parseSchemaText(d.outputSchemaText);
  const starters = d.startersText
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const tools = splitNames(d.toolsText);
  const skills = d.skillPackages
    .filter((k) => k.name.trim())
    .map((k) => ({ name: k.name.trim(), description: k.description.trim(), files: k.files }));
  const mcps = d.mcpServers.filter((m) => m.name.trim()).map(mcpOfRow);
  // 名字与提示词都填了才算数 —— 半截的子代理存进去只会在运行时报错
  const subs = d.subagents
    .filter((s) => s.name.trim() && s.prompt.trim())
    .map((s) => ({
      name: s.name.trim(),
      ...(s.description.trim() ? { description: s.description.trim() } : {}),
      prompt: s.prompt.trim(),
      ...(s.model ? { model: s.model } : {}),
      background: false,
    }));
  const vars = d.variables
    .filter((v) => v.name.trim())
    .map((v) => ({
      name: v.name.trim(),
      ...(v.description.trim() ? { description: v.description.trim() } : {}),
      required: v.required,
      secret: v.secret,
    }));
  const advanced = d.advancedText.trim()
    ? (JSON.parse(d.advancedText) as Record<string, unknown>)
    : {};
  const { approvalRules: advRules, ...advRest } = advanced;
  const all = isObj(advRules) ? advRules.all : undefined;
  const ruleTools = splitNames(d.approvalToolsText);
  const rulePatterns = d.approvalPatternsText
    .split(/[,，\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const rules =
    d.approvalToolsText.trim() || d.approvalPatternsText.trim()
      ? { tools: ruleTools, commandPatterns: rulePatterns }
      : undefined;
  const approvalRules = all !== undefined ? { ...(rules ?? {}), all } : rules;

  const form: Record<string, unknown> = {
    systemPrompt: d.systemPrompt,
    model: d.model,
    maxTurns: Number(d.maxTurns) || 20,
    effort: d.effort || undefined,
    inputSchema: input.ok && !input.empty ? input.value : undefined,
    outputSchema: output.ok && !output.empty ? output.value : undefined,
    // 留空 = 不限制;空数组在运行时同样是不限制
    tools: tools.length ? tools.map((name) => ({ name })) : emptyList(base.tools),
    skillPackages: skills.length ? skills : emptyList(base.skillPackages),
    mcpServers: mcps.length ? mcps : emptyList(base.mcpServers),
    subagents: subs.length ? subs : emptyList(base.subagents),
    variables: vars.length ? vars : emptyList(base.variables),
    permissionMode:
      d.permissionMode === "default" && base.permissionMode === undefined
        ? undefined
        : d.permissionMode,
    unattendedApproval: d.unattendedApproval || undefined,
    starters: starters.length ? starters.slice(0, 4) : undefined,
    approvalRules,
  };
  // 高级参数里删掉的键:原来在底上、现在不在了,一并清掉
  for (const k of Object.keys(base)) {
    if (!FORM_KEYS.includes(k) && !HIDDEN_KEYS.includes(k) && !(k in advRest)) form[k] = undefined;
  }
  Object.assign(form, advRest);

  const id = d.id.trim();
  return {
    ...(id ? { id } : {}),
    name: d.name.trim(),
    description: d.description.trim() || undefined,
    icon: d.icon || undefined,
    webhookUrl: opts.canManageWebhook ? d.webhookUrl.trim() || undefined : undefined,
    config: overlayConfig(base, form),
    ...(opts.isNew ? { createOnly: true } : {}),
  };
}

/** 与新建弹层同一条 ID 规则 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,35}$/;

export type SaveBlock = { reason: string; section: SectionKey } | null;

/** 自动保存要暂停的原因(以及该去哪一节处理);可以保存返回 null */
export function saveBlock(
  d: ProfileDraft,
  ctx: { isNew: boolean; takenIds: readonly string[] },
): SaveBlock {
  if (!d.name.trim()) return { reason: "名称为空", section: "identity" };
  if (!d.systemPrompt.trim()) return { reason: "提示词为空", section: "prompt" };
  if (ctx.isNew && d.id.trim()) {
    if (!ID_PATTERN.test(d.id.trim())) return { reason: "ID 格式不对", section: "identity" };
    if (ctx.takenIds.includes(d.id.trim())) return { reason: "ID 已被占用", section: "identity" };
  }
  if (!parseSchemaText(d.inputSchemaText).ok)
    return { reason: "输入契约的 Schema 有误", section: "contract" };
  if (!parseSchemaText(d.outputSchemaText).ok)
    return { reason: "输出契约的 Schema 有误", section: "contract" };
  const badEnv = d.mcpServers.find((m) => m.type === "stdio" && envError(m.envText));
  if (badEnv)
    return {
      reason: `MCP「${badEnv.name || "未命名"}」的 env 不是字符串键值 JSON`,
      section: "ability",
    };
  if (advancedError(d.advancedText)) return { reason: "高级参数有误", section: "model" };
  return null;
}

/** 新建弹层同一条 ID 规则的错误文案;不需要检查时返回空串 */
export function idError(id: string, takenIds: readonly string[]): string {
  const v = id.trim();
  if (!v) return "";
  if (!ID_PATTERN.test(v)) return "只能用小写字母、数字和短横线，2 到 36 位，不能以短横线开头";
  if (takenIds.includes(v)) return "ID 已被占用";
  return "";
}

/** A8「编排完整」:名称与提示词非空 */
export function orchestrationReady(d: ProfileDraft): boolean {
  return Boolean(d.name.trim() && d.systemPrompt.trim());
}

export interface SectionContext {
  /** 智能体已经建好(新建且未保存时为 false) */
  exists: boolean;
  canManageWebhook: boolean;
  /** 模型的显示名(含「跟随平台默认」) */
  modelLabel: string;
  knowledge: { count: number; titles: string[] };
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function schemaKeys(text: string): string | null {
  const r = parseSchemaText(text);
  if (!r.ok) return null;
  if (r.empty) return "文本";
  const props = r.value.properties;
  return isObj(props) && Object.keys(props).length ? Object.keys(props).join(", ") : "对象";
}

export function sectionFilled(k: SectionKey, d: ProfileDraft, ctx: SectionContext): boolean {
  switch (k) {
    case "identity":
      return Boolean(d.name.trim());
    case "prompt":
      return Boolean(d.systemPrompt.trim());
    case "model":
    case "approval":
      return ctx.exists;
    case "ability":
      return Boolean(
        d.toolsText.trim() || d.skillPackages.length || d.mcpServers.length || d.subagents.length,
      );
    case "knowledge":
      return ctx.knowledge.count > 0;
    case "vars":
      return d.variables.length > 0;
    case "contract":
      return Boolean(d.inputSchemaText.trim() || d.outputSchemaText.trim());
    case "webhook":
      return ctx.canManageWebhook ? Boolean(d.webhookUrl.trim()) : ctx.exists;
  }
}

export const EMPTY_SUMMARY = "还没填：点开直接手动填，或让智能体设计器写";

/** 每节折叠时的一行摘要 */
export function sectionSummary(k: SectionKey, d: ProfileDraft, ctx: SectionContext): string {
  if (!sectionFilled(k, d, ctx) && k !== "webhook" && k !== "ability") return EMPTY_SUMMARY;
  switch (k) {
    case "identity":
      return `${d.name.trim()}，${Math.min(lines(d.startersText).length, 4)} 条开场建议`;
    case "prompt": {
      const rules = d.systemPrompt
        .split("\n")
        .filter((l) => /^\s*\d+[.、]/.test(l))
        .map((l) => l.replace(/^\s*\d+[.、]\s*/, "").trim());
      return rules.length
        ? rules.join("；")
        : d.systemPrompt.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    case "model": {
      const effort = EFFORTS.find(([v]) => v === d.effort)?.[1] ?? "跟随模型默认";
      return `${ctx.modelLabel}，最大 ${Number(d.maxTurns) || 20} 轮，推理强度${effort}`;
    }
    case "ability": {
      if (!sectionFilled(k, d, ctx) && !ctx.exists) return EMPTY_SUMMARY;
      const tools = splitNames(d.toolsText).length;
      return `${tools ? `工具 ${tools} 个` : "工具不限制"}，技能包 ${d.skillPackages.length} 个，MCP ${d.mcpServers.length} 个，子代理 ${d.subagents.length} 个`;
    }
    case "knowledge":
      return `${ctx.knowledge.count} 篇：${ctx.knowledge.titles
        .slice(0, 6)
        .map((t) => `《${t.replace(/\.(pdf|docx|pptx|xlsx|txt|md|csv)$/i, "")}》`)
        .join("")}`;
    case "vars":
      return d.variables.map((v) => `${v.name}${v.secret ? "（密钥）" : ""}`).join("，");
    case "contract": {
      const a = schemaKeys(d.inputSchemaText);
      const b = schemaKeys(d.outputSchemaText);
      if (a === null || b === null) return "Schema 有误";
      return `输入 ${a}；输出 ${b}`;
    }
    case "approval":
      return `${PERMISSION_META[d.permissionMode].label}；需审批工具 ${splitNames(d.approvalToolsText).join("、") || "无"}`;
    case "webhook":
      if (!ctx.canManageWebhook) return "（已隐藏）";
      return d.webhookUrl.trim() || (ctx.exists ? "未配置" : EMPTY_SUMMARY);
  }
}

/** 开场建议的条数提示 */
export function startersHint(text: string): { text: string; over: boolean } {
  const n = lines(text).length;
  return n > 4
    ? { text: `共 ${n} 条，只取前 4 条`, over: true }
    : { text: `${n}/4 条`, over: false };
}

/** 新建技能包/MCP/子代理/变量的空行 */
export const newSkill = (uid: string): SkillDraft => ({
  uid,
  name: "",
  description: "",
  files: { "SKILL.md": "" },
});
export const newMcp = (uid: string): McpDraft => ({
  uid,
  name: "",
  type: "http",
  url: "",
  command: "",
  argsText: "",
  envText: "",
});
export const newSubagent = (uid: string): SubagentDraft => ({
  uid,
  name: "",
  description: "",
  prompt: "",
  model: "",
});
export const newVariable = (uid: string): VariableDraft => ({
  uid,
  name: "",
  description: "",
  required: false,
  secret: false,
});

/** 变量名自动转大写,只保留 A-Z0-9_ */
export const normalizeVarName = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "").toUpperCase();

/** 新文件路径的错误;合法返回 null */
export function newFilePathError(path: string, files: Record<string, string>): string | null {
  const p = path.trim();
  if (!p) return "路径不能为空";
  if (p === "SKILL.md") return "不能和 SKILL.md 重名";
  if (p in files) return "已有同名文件";
  if (p.split("/").includes("..")) return "不能包含 ..";
  if (p.startsWith("/")) return "不能用绝对路径";
  if (!isSafeSkillPath(p)) return "只允许字母、数字、._- 和 /";
  return findPathConflict([...Object.keys(files), p]);
}
