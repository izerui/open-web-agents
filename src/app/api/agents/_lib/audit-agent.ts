import type { Agent } from "@/lib/modules/agent/ports";
import { changedFields } from "@/lib/modules/audit/domain/events";

/** 审计用:智能体可改动的内容摊平成一层,便于算"改了哪些字段"。 */
function flat(a: Pick<Agent, "name" | "icon" | "description" | "webhookUrl" | "config">) {
  return {
    name: a.name,
    icon: a.icon,
    description: a.description,
    webhookUrl: a.webhookUrl,
    ...a.config,
  } as Record<string, unknown>;
}

/** 保存前后对比,只给字段名(提示词、MCP 配置的值可能含敏感内容,不进审计)。 */
export function agentChanges(before: Agent | null | undefined, after: Agent): string[] {
  return changedFields(before ? flat(before) : undefined, flat(after));
}
