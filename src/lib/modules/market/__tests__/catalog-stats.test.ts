import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMarket } from "../application/catalog";
import type { MarketStats, MarketStatsSource } from "../domain/stats";
import { fixture, publishedAgent } from "./fixture";

let container: Awaited<ReturnType<typeof fixture>>;
const customer = { type: "web", userId: "customer", role: "user" } as const;
const subject = { userId: "customer", role: "user", groupIds: [] } as never;

beforeEach(async () => {
  container = await fixture();
  await container.agents.setMarketListing(publishedAgent.id, {
    listed: true,
    category: "research",
  });
});

function statsOf(map: Record<string, MarketStats>): MarketStatsSource & {
  forAgents: ReturnType<typeof vi.fn>;
} {
  return { forAgents: vi.fn(async () => new Map(Object.entries(map))) };
}

describe("AgentMarket 带作者、使用次数与每次约花费", () => {
  it("列表一次批量取齐统计,每项带上字段", async () => {
    const stats = statsOf({
      [publishedAgent.id]: { author: "owner", useCount: 18000, avgCredits: 2.3 },
    });
    const market = new AgentMarket(container.agents, container.releases, stats);
    const items = await market.list(customer, subject, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ author: "owner", useCount: 18000, avgCredits: 2.3 });
    expect(items[0]?.publishedAt).toEqual(expect.any(Number));
    expect(stats.forAgents).toHaveBeenCalledTimes(1);
    expect(stats.forAgents.mock.calls[0]?.[0]).toEqual([
      { id: publishedAgent.id, ownerId: publishedAgent.ownerId },
    ]);
  });

  it("统计取不到时列表照常返回,字段为空", async () => {
    const stats = { forAgents: vi.fn(async () => Promise.reject(new Error("db down"))) };
    const market = new AgentMarket(container.agents, container.releases, stats);
    const items = await market.list(customer, subject, []);
    expect(items[0]).toMatchObject({ author: null, useCount: 0, avgCredits: null });
  });

  it("没有注入统计时字段为空", async () => {
    const market = new AgentMarket(container.agents, container.releases);
    const items = await market.list(customer, subject, []);
    expect(items[0]).toMatchObject({ author: null, useCount: 0, avgCredits: null });
  });

  it("详情同样带统计,不暴露所有者 id", async () => {
    const stats = statsOf({
      [publishedAgent.id]: { author: "owner", useCount: 3, avgCredits: null },
    });
    const market = new AgentMarket(container.agents, container.releases, stats);
    const detail = await market.detail(customer, subject, [], publishedAgent.id);
    expect(detail).toMatchObject({ author: "owner", useCount: 3, avgCredits: null });
    expect(JSON.stringify(detail)).not.toContain("ownerId");
  });
});
