// Builder:助手配置 + 运行上下文 → AgentSpec。纯逻辑,零框架/SDK 依赖。
// 组装优先级:框架默认 < 助手配置;凭证与模型别名的三级覆盖在 resolve-credentials 里完成。

import type { AgentSpec, ModelAlias, RunContext } from "@/lib/shared";
import type { AssistantConfig } from "./config";

export function buildSpec(
  cfg: AssistantConfig,
  _ctx: RunContext,
  overrides?: { model?: ModelAlias },
): AgentSpec {
  return {
    systemPrompt: cfg.systemPrompt,
    skills: cfg.skills,
    mcpServers: cfg.mcpServers,
    tools: cfg.tools,
    // 平台强制子代理同步执行,保证过程全程可监控
    subagents: cfg.subagents?.map((s) => ({ ...s, background: false as const })),
    model: { alias: overrides?.model ?? cfg.model },
    outputSchema: cfg.outputSchema,
    verifyRules: cfg.verifyRules,
    limits: { maxTurns: cfg.maxTurns, effort: cfg.effort },
    escapeHatch: cfg.escapeHatch,
  };
}
