// Builder:智能体配置 + 运行上下文 → AgentSpec。纯逻辑,零框架/SDK 依赖。
// 组装优先级:框架默认 < 智能体配置;凭证与模型别名的三级覆盖在 resolve-credentials 里完成。

import type { AgentSpec, McpDef, ModelAlias, RunContext, SkillPackage } from "@/lib/shared";
import type { AgentConfig, VariableDef } from "./config";

const VAR_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_PATTERN, (match, name: string) => vars[name] ?? match);
}

function substituteMcpEnv(
  servers: McpDef[] | undefined,
  vars: Record<string, string>,
): McpDef[] | undefined {
  if (!servers?.length) return servers;
  return servers.map((s) => ({
    ...s,
    ...(s.env
      ? {
          env: Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, substituteVars(v, vars)]),
          ),
        }
      : {}),
    ...(s.url !== undefined ? { url: substituteVars(s.url, vars) } : {}),
  }));
}

function substituteSkills(
  packages: SkillPackage[] | undefined,
  vars: Record<string, string>,
): SkillPackage[] | undefined {
  if (!packages?.length) return packages;
  return packages.map((p) => ({
    ...p,
    files: Object.fromEntries(
      Object.entries(p.files).map(([k, v]) => [k, substituteVars(v, vars)]),
    ),
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
  const hasVars = Object.keys(vars).length > 0;

  let systemPrompt = knowledge ? `${cfg.systemPrompt}\n\n${knowledge}` : cfg.systemPrompt;
  if (hasVars) systemPrompt = substituteVars(systemPrompt, vars);

  return {
    systemPrompt,
    skillPackages: hasVars ? substituteSkills(cfg.skillPackages, vars) : cfg.skillPackages,
    mcpServers: hasVars ? substituteMcpEnv(cfg.mcpServers, vars) : cfg.mcpServers,
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
