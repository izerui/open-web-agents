// Builder：智能体配置 + 运行上下文 → AgentSpec。纯逻辑，零框架/SDK 依赖。
// 组装优先级：框架默认 < 智能体配置；凭证与模型别名的三级覆盖在 resolve-credentials 里完成。

import type { AgentSpec, McpDef, ModelAlias, RunContext } from "@/lib/shared";
import type { AgentConfig, VariableDef } from "./config";

const VAR_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_PATTERN, (match, name: string) => vars[name] ?? match);
}

function substituteMcpEnv(
  servers: McpDef[] | undefined,
  allVars: Record<string, string>,
): McpDef[] | undefined {
  if (!servers?.length) return servers;
  return servers.map((s) => ({
    ...s,
    ...(s.env
      ? {
          env: Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, substituteVars(v, allVars)]),
          ),
        }
      : {}),
    ...(s.url !== undefined ? { url: substituteVars(s.url, allVars) } : {}),
  }));
}

export class MissingRequiredVariables extends Error {
  constructor(readonly missing: string[]) {
    super(`缺少必填变量: ${missing.join(", ")}`);
    this.name = "MissingRequiredVariables";
  }
}

export function checkRequiredVariables(
  defs: VariableDef[] | undefined,
  values: Record<string, string>,
): string[] {
  if (!defs?.length) return [];
  return defs.filter((d) => d.required && !values[d.name]?.trim()).map((d) => d.name);
}

/**
 * 按 secret 标记拆分变量值：
 * - plain：普通变量，可文本替换到 systemPrompt 和 MCP env
 * - secret：密钥变量，只注入 MCP env 和运行环境，不进提示词和技能文件
 * - secretEnv：密钥变量以 OWA_VAR_ 前缀注入运行环境，技能脚本通过 process.env 读取
 */
export function splitVariables(
  defs: VariableDef[] | undefined,
  values: Record<string, string>,
): {
  plain: Record<string, string>;
  secrets: Record<string, string>;
  secretEnv: Record<string, string>;
} {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  if (!defs?.length) return { plain, secrets, secretEnv };
  for (const def of defs) {
    const value = values[def.name];
    if (value === undefined) continue;
    if (def.secret) {
      secrets[def.name] = value;
      secretEnv[`OWA_VAR_${def.name}`] = value;
    } else {
      plain[def.name] = value;
    }
  }
  return { plain, secrets, secretEnv };
}

export function buildSpec(
  cfg: AgentConfig,
  _ctx: RunContext,
  overrides?: {
    model?: ModelAlias;
    knowledgeContext?: string;
    resolvedVariables?: Record<string, string>;
  },
): AgentSpec {
  const knowledge = overrides?.knowledgeContext?.trim();
  const vars = overrides?.resolvedVariables ?? {};
  const { plain, secrets } = splitVariables(cfg.variables, vars);
  const hasPlain = Object.keys(plain).length > 0;
  const allMcpVars = { ...plain, ...secrets };
  const hasAnyMcpVars = Object.keys(allMcpVars).length > 0;

  let systemPrompt = knowledge ? `${cfg.systemPrompt}\n\n${knowledge}` : cfg.systemPrompt;
  if (hasPlain) systemPrompt = substituteVars(systemPrompt, plain);

  return {
    systemPrompt,
    skillPackages: cfg.skillPackages,
    mcpServers: hasAnyMcpVars ? substituteMcpEnv(cfg.mcpServers, allMcpVars) : cfg.mcpServers,
    tools: cfg.tools,
    subagents: cfg.subagents?.map((s) => ({ ...s, background: false as const })),
    model: { alias: overrides?.model ?? cfg.model },
    outputSchema: cfg.outputSchema,
    approvalRules: cfg.approvalRules,
    permissionMode: cfg.permissionMode,
    limits: { maxTurns: cfg.maxTurns, effort: cfg.effort },
    escapeHatch: cfg.escapeHatch,
  };
}
