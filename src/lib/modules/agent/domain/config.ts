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
  VerifyRule,
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
  verifyRules?: VerifyRule[];
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
   * 没有审批人时(接口调用、嵌入组件)命中审批规则怎么办。
   * 不配:接口调用放行(历史行为),嵌入组件拒绝(访客不是审批人)。
   */
  unattendedApproval?: "allow" | "deny";
  /** 开场建议:工作台空会话时展示的几条示例输入(最多 4 条)。 */
  starters?: string[];
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
  verifyRules: true,
  approvalRules: true,
  permissionMode: true,
  escapeHatch: true,
  unattendedApproval: true,
  starters: true,
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
 * 给只读者看的配置:去掉 MCP 的环境变量(常放密钥)与逃生舱。
 * 能改这个智能体的人才看得到完整配置。
 */
export function redactAgentConfigForReader(cfg: AgentConfig): AgentConfig {
  const { escapeHatch: _hatch, ...rest } = cfg;
  return {
    ...rest,
    mcpServers: cfg.mcpServers?.map((m) =>
      m.env ? { ...m, env: Object.fromEntries(Object.keys(m.env).map((k) => [k, "***"])) } : m,
    ),
  };
}
