import type { Agent, AgentSnapshot } from "@/lib/modules/agent/ports";

export const MARKET_CATEGORIES = [
  { id: "general", name: "通用助手" },
  { id: "research", name: "研究分析" },
  { id: "content", name: "内容创作" },
  { id: "development", name: "开发工具" },
  { id: "operations", name: "办公运营" },
] as const;

export function validCategory(value: unknown): value is string {
  return typeof value === "string" && MARKET_CATEGORIES.some((c) => c.id === value);
}

/** 显式白名单:市场使用权不暴露定义、技能正文、工具连接或回调地址。 */
export function marketSummary(agent: Agent, published: AgentSnapshot) {
  return {
    id: agent.id,
    name: published.name,
    description: published.description,
    icon: published.icon,
    marketListed: agent.marketListed === true,
    category: agent.marketCategory ?? "general",
    publishedVersion: agent.publishedVersion,
    config: {
      model: published.config.model,
      starters: published.config.starters,
      inputSchema: published.config.inputSchema,
      outputSchema: published.config.outputSchema,
    },
    published: {
      version: agent.publishedVersion,
      inputSchema: published.config.inputSchema,
      outputSchema: published.config.outputSchema,
    },
    canWrite: false,
    canRead: false,
    canManageWebhook: false,
  };
}

export type MarketAgent = ReturnType<typeof marketSummary>;
