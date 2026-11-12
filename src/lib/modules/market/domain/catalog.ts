import type { Agent, AgentSnapshot } from "@/lib/modules/agent/ports";
import { EMPTY_MARKET_STATS, type MarketStats } from "./stats";

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
export function marketSummary(
  agent: Agent,
  published: AgentSnapshot & { createdAt?: number; note?: string },
  stats: MarketStats = EMPTY_MARKET_STATS,
) {
  return {
    id: agent.id,
    name: published.name,
    description: published.description,
    icon: published.icon,
    marketListed: agent.marketListed === true,
    category: agent.marketCategory ?? "general",
    publishedVersion: agent.publishedVersion,
    /** 当前发布版本的发布时间(ms)与版本说明;「最新」排序与详情的版本说明用 */
    publishedAt: published.createdAt ?? null,
    versionNote: published.note ?? null,
    /** A10 / A11:作者显示名、近 90 天使用次数、近 50 次成功运行的平均实扣积分 */
    author: stats.author,
    useCount: stats.useCount,
    avgCredits: stats.avgCredits,
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

/** 详情页的版本说明:当前发布版及之前最近 3 版(只有版本号、发布时间、说明)。 */
export interface MarketVersionNote {
  version: number;
  createdAt: number;
  note: string | null;
}

export type MarketAgentDetail = MarketAgent & { recentVersions?: MarketVersionNote[] };
