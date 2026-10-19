// 智能体配置:落库为 agents.config(JSON)的域内形状。零外部依赖。

import type {
  Effort,
  JsonSchema,
  McpDef,
  ModelAlias,
  PermissionMode,
  SkillPackage,
  SubagentDef,
  ToolDef,
} from "@/lib/shared";

/**
 * 一个智能体 = 一个只干特定某件事的专精"员工"。
 * 是否定义 outputSchema,决定它能否被企业系统当接口消费(见设计文档 §3 统一接口原则)。
 */
export interface AgentConfig {
  systemPrompt: string;
  /**
   * 【已废弃,不生效】早期只存技能名,运行时从未真正加载(settingSources 为空时 SDK 不发现技能)。
   * 保留字段只为读回旧数据;技能请用 skillPackages。
   */
  skills?: string[];
  /** 智能体自带的技能包(SKILL.md + 可选文件),运行时作为本地插件加载。 */
  skillPackages?: SkillPackage[];
  mcpServers?: McpDef[];
  tools?: ToolDef[];
  subagents?: SubagentDef[];
  model: ModelAlias;
  effort?: Effort;
  maxTurns?: number;
  /**
   * 入站契约。声明了它,对外 invoke 就必须按它传参,不合格直接 400。
   *
   * 【曾经只有一个数据库列】input_schema 建了表、invoke 路由的注释也写着
   * "符合智能体 inputSchema 的输入",但配置类型里没有这个字段、没有任何校验 ——
   * 一个只活在列名和注释里的功能,而设计文稿的 MVP 清单明确列了它。
   */
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** 人工审批规则(HITL)。不配则不审批。 */
  approvalRules?: { tools?: string[]; commandPatterns?: string[]; all?: boolean };
  /**
   * 权限模式。不配等同 "default"。
   *
   * 按场景选:web 对话有人盯着 → default 配审批;接口调用无人值守 →
   * bypassPermissions(等一个不会来的确认只会挂到超时)。
   * 无论选哪个,路径围栏与审批都仍生效 —— 它们在 PreToolUse hook 上。
   */
  permissionMode?: PermissionMode;
  /** 逃生舱:透传给 SDK options 的原始覆盖,最后 spread。 */
  escapeHatch?: Record<string, unknown>;
  /**
   * 没有审批人时(接口调用、评测)命中审批规则怎么办。不配:放行(历史行为)。
   */
  unattendedApproval?: "allow" | "deny";
  /** 开场建议:工作台空会话时展示的几条示例输入(最多 4 条)。 */
  starters?: string[];
  /** 智能体需要使用者提供的变量(密钥、地址等),值按用户存储,不在配置里。 */
  variables?: VariableDef[];
}

export interface VariableDef {
  name: string;
  description?: string;
  required: boolean;
  /** true = 值加密存储且 GET 时脱敏。 */
  secret: boolean;
}

/**
 * 配置字段的完整清单。类型是 Record<keyof AgentConfig, true> —— AgentConfig 新增字段而这里
 * 没加,编译直接报错。
 *
 * 【为什么需要】保存接口按白名单逐字段组装配置(外部塞不进意料之外的键),代价是新字段忘了加
 * 就被静默丢弃:保存返回 201、界面显示成功,读回来字段没了。inputSchema 漏过一次,
 * permissionMode 又漏过一次(构建器里选的权限模式从未生效)。
 */
const AGENT_CONFIG_KEYS: Record<keyof AgentConfig, true> = {
  systemPrompt: true,
  skills: true,
  skillPackages: true,
  mcpServers: true,
  tools: true,
  subagents: true,
  model: true,
  effort: true,
  maxTurns: true,
  inputSchema: true,
  outputSchema: true,
  approvalRules: true,
  permissionMode: true,
  escapeHatch: true,
  unattendedApproval: true,
  starters: true,
  variables: true,
};

/** 只取 AgentConfig 认识的字段。 */
export function pickAgentConfig(raw: Partial<AgentConfig>): Partial<AgentConfig> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(AGENT_CONFIG_KEYS)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<AgentConfig>;
}

/**
 * 给只读者看的配置:去掉逃生舱,并把 MCP 里可能藏着密钥的地方打码 ——
 * 环境变量的值、地址里的查询串与账号密码(常见 `?token=…`、`https://user:pass@…`)、
 * stdio 程序的参数(常见 `--token=…`)。只读者仍看得到用了哪些 MCP、连到哪个主机。
 * 能改这个智能体的人才看得到完整配置。
 */
export function redactAgentConfigForReader(cfg: AgentConfig): AgentConfig {
  const { escapeHatch: _hatch, ...rest } = cfg;
  return {
    ...rest,
    mcpServers: cfg.mcpServers?.map((m) => ({
      ...m,
      ...(m.env ? { env: Object.fromEntries(Object.keys(m.env).map((k) => [k, "***"])) } : {}),
      ...(m.url !== undefined ? { url: redactUrl(m.url) } : {}),
      ...(m.args ? { args: m.args.map(() => "***") } : {}),
    })),
  };
}

/** 地址只留协议、主机、路径;带了查询串或账号密码就标 *** 提示"这里有被隐去的内容" */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hidden = u.search !== "" || u.username !== "" || u.password !== "" || u.hash !== "";
    return `${u.protocol}//${u.host}${u.pathname}${hidden ? "?***" : ""}`;
  } catch {
    return "***";
  }
}

const PURE_VAR_REF = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const CONTAINS_VAR_REF = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;
const BEARER_TEMPLATE = /^Bearer\s+\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const PLACEHOLDER_PREFIX = "__owa_var_";

function cloneRedactValue(value: string): string {
  if (PURE_VAR_REF.test(value)) return value;
  if (BEARER_TEMPLATE.test(value)) return value;
  return "***";
}

function cloneRedactUrl(url: string): string {
  if (PURE_VAR_REF.test(url)) return url;
  if (!CONTAINS_VAR_REF.test(url)) return redactUrl(url);
  const varMap = new Map<string, string>();
  const expanded = url.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    const lower = name.toLowerCase();
    varMap.set(lower, name);
    return `${PLACEHOLDER_PREFIX}${lower}`;
  });
  let u: URL;
  try {
    u = new URL(expanded);
  } catch {
    return "***";
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  const kept: [string, string][] = [];
  const purePlaceholder = /^__owa_var_[a-z_][a-z0-9_]*$/;
  for (const [k, v] of u.searchParams) {
    if (purePlaceholder.test(v)) {
      kept.push([k, v]);
    }
  }
  u.search = "";
  let result = u.toString();
  if (kept.length > 0) {
    const qs = kept.map(([k, v]) => `${k}=${v}`).join("&");
    result += `?${qs}`;
  }
  return result.replace(/__owa_var_([a-z_][a-z0-9_]*)/g, (_, lower: string) => {
    const original = varMap.get(lower) ?? lower;
    return `{{${original}}}`;
  });
}

export function redactAgentConfigForClone(cfg: AgentConfig): AgentConfig {
  const { escapeHatch: _hatch, ...rest } = cfg;
  return {
    ...rest,
    mcpServers: cfg.mcpServers?.map((m) => ({
      ...m,
      ...(m.env
        ? {
            env: Object.fromEntries(
              Object.entries(m.env).map(([k, v]) => [k, cloneRedactValue(v)]),
            ),
          }
        : {}),
      ...(m.url !== undefined ? { url: cloneRedactUrl(m.url) } : {}),
      ...(m.args ? { args: m.args.map((a) => cloneRedactValue(a)) } : {}),
    })),
  };
}

export function checkUrlTemplate(raw: string): string | null {
  if (PURE_VAR_REF.test(raw)) return null;
  const expanded = raw.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, "placeholder");
  let u: URL;
  try {
    u = new URL(expanded);
  } catch {
    return "URL 格式不正确";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "只支持 http/https";
  }
  return null;
}

/**
 * URL 合并：base（协议+主机+路径）和 query 参数分别比较。
 * - 与 baseline 完全相同 → 恢复原值
 * - base 改了 → 取新 base + 合并后 query
 * - query 改了 → 按参数级合并：原值参数保留，新增追加，明确修改的覆盖
 */
function mergeUrl(
  draft: string | undefined,
  base: string | undefined,
  orig: string | undefined,
): string | undefined {
  if (draft === undefined) return orig;
  if (draft === base) return orig;
  if (!base || !orig) return draft;

  const splitQ = (s: string): [string, string] => {
    const i = s.indexOf("?");
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i)];
  };

  const parseParams = (qs: string): Map<string, string> => {
    const m = new Map<string, string>();
    if (!qs || qs === "?") return m;
    const raw = qs.startsWith("?") ? qs.slice(1) : qs;
    for (const pair of raw.split("&")) {
      if (!pair || pair === "***") continue;
      const eq = pair.indexOf("=");
      if (eq < 0) m.set(pair, "");
      else m.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return m;
  };

  const buildQuery = (params: Map<string, string>): string => {
    if (params.size === 0) return "";
    return `?${[...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join("&")}`;
  };

  const [dBase, dQuery] = splitQ(draft);
  const [bBase, bQuery] = splitQ(base);
  const [oBase, oQuery] = splitQ(orig);

  const baseChanged = dBase !== bBase;
  const queryChanged = dQuery !== bQuery;

  if (!baseChanged && !queryChanged) return orig;

  const resultBase = baseChanged ? dBase : oBase;
  if (!queryChanged) return resultBase + oQuery;

  const dParams = parseParams(dQuery);
  const bParams = parseParams(bQuery);
  const oParams = parseParams(oQuery);

  const merged = new Map<string, string>();
  // Start with all original params (including hidden ones stripped by redaction)
  for (const [k, v] of oParams) merged.set(k, v);
  // Remove params that were visible in baseline but explicitly deleted from draft
  for (const [k] of bParams) {
    if (!dParams.has(k)) merged.delete(k);
  }
  // Add/override params from draft
  for (const [k, v] of dParams) {
    if (!bParams.has(k)) merged.set(k, v);
    else if (v !== bParams.get(k)) merged.set(k, v);
  }

  return resultBase + buildQuery(merged);
}

export function restoreMcpSecrets(
  candidate: AgentConfig,
  original: AgentConfig | undefined,
  baseline: McpDef[] | undefined,
): AgentConfig {
  if (!original?.mcpServers?.length || !candidate.mcpServers?.length) return candidate;
  const origByName = new Map(original.mcpServers.map((m) => [m.name, m]));
  const baseByName = new Map((baseline ?? []).map((m) => [m.name, m]));
  return {
    ...candidate,
    mcpServers: candidate.mcpServers.map((m) => {
      const orig = origByName.get(m.name);
      const base = baseByName.get(m.name);
      if (!orig || !base) return m;
      return {
        ...m,
        url: mergeUrl(m.url, base.url, orig.url),
        env: m.env
          ? Object.fromEntries(
              Object.entries(m.env).map(([k, v]) => [
                k,
                v === base.env?.[k] ? (orig.env?.[k] ?? v) : v,
              ]),
            )
          : orig.env,
        args: m.args?.map((a, i) => (a === base.args?.[i] ? (orig.args?.[i] ?? a) : a)),
      };
    }),
  };
}
