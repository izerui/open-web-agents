// 智能体配置:落库为 agents.config(JSON)的域内形状。零外部依赖。

import type {
  Effort,
  JsonSchema,
  McpDef,
  ModelAlias,
  PermissionMode,
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
  skills?: string[];
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
}
