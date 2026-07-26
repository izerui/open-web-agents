// Builder:助手配置 + 运行上下文 → AgentSpec。纯逻辑,零框架/SDK 依赖。
// 组装优先级:框架默认 < 助手配置;凭证与模型别名的三级覆盖在 resolve-credentials 里完成。

import type { AgentSpec, ModelAlias, RunContext } from "@/lib/shared";
import type { AssistantConfig } from "./config";

export function buildSpec(
  cfg: AssistantConfig,
  _ctx: RunContext,
  overrides?: {
    model?: ModelAlias;
    /**
     * 检索到的知识片段,追加在系统提示词之后。
     * 由调用方(编排层)先检索好再传进来 —— 检索要碰 IO,不该混进这个纯函数。
     */
    knowledgeContext?: string;
  },
): AgentSpec {
  const knowledge = overrides?.knowledgeContext?.trim();
  return {
    systemPrompt: knowledge ? `${cfg.systemPrompt}\n\n${knowledge}` : cfg.systemPrompt,
    skills: cfg.skills,
    mcpServers: cfg.mcpServers,
    tools: cfg.tools,
    // 平台强制子代理同步执行,保证过程全程可监控
    subagents: cfg.subagents?.map((s) => ({ ...s, background: false as const })),
    model: { alias: overrides?.model ?? cfg.model },
    outputSchema: cfg.outputSchema,
    verifyRules: cfg.verifyRules,
    approvalRules: cfg.approvalRules,
    limits: { maxTurns: cfg.maxTurns, effort: cfg.effort },
    escapeHatch: cfg.escapeHatch,
  };
}
