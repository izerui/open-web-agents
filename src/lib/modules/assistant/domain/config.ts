// 助手配置:落库为 assistants.config(JSON)的域内形状。零外部依赖。

import type {
  Effort,
  JsonSchema,
  McpDef,
  ModelAlias,
  SubagentDef,
  ToolDef,
  VerifyRule,
} from "@/lib/shared";

/**
 * 一个助手 = 一个只干特定某件事的专精"员工"。
 * 是否定义 outputSchema,决定它能否被企业系统当接口消费(见设计文档 §3 统一接口原则)。
 */
export interface AssistantConfig {
  systemPrompt: string;
  skills?: string[];
  mcpServers?: McpDef[];
  tools?: ToolDef[];
  subagents?: SubagentDef[];
  model: ModelAlias;
  effort?: Effort;
  maxTurns?: number;
  outputSchema?: JsonSchema;
  verifyRules?: VerifyRule[];
  /** 逃生舱:透传给 SDK options 的原始覆盖,最后 spread。 */
  escapeHatch?: Record<string, unknown>;
}
