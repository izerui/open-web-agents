import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { accessGrants, agentVersions, agents as agentsTable } from "@/lib/db/schema";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.OWA_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/owa_test") {
  throw new Error("Market SQL tests require the dedicated owa_test database");
}

describe.skipIf(!databaseUrl)("market listing SQL contract", () => {
  const connection = databaseUrl ? createDb(databaseUrl) : undefined;
  const ids = new Set<string>();

  function repos() {
    if (!connection) throw new Error("test database not configured");
    const agents = new MysqlAgentRepo(connection.db);
    return {
      agents,
      grants: new MysqlGrantRepo(connection.db),
      releases: new AgentReleases(agents, new MysqlAgentVersionRepo(connection.db)),
    };
  }

  async function seed() {
    const id = randomUUID().replaceAll("-", "").slice(0, 24);
    ids.add(id);
    return repos().agents.upsert({
      id,
      ownerId: `market-test-${id.slice(0, 8)}`,
      name: "SQL market test",
      config: { systemPrompt: "Private prompt", model: "sonnet" },
    });
  }

  afterAll(async () => {
    if (!connection) return;
    try {
      for (const id of ids) {
        await connection.db.delete(accessGrants).where(eq(accessGrants.resourceId, id));
        await connection.db.delete(agentVersions).where(eq(agentVersions.agentId, id));
        await connection.db.delete(agentsTable).where(eq(agentsTable.id, id));
      }
    } finally {
      await connection.pool.end();
    }
  });

  it("requires a real published snapshot; ordinary save cannot tamper with listing metadata", async () => {
    const { agents, releases } = repos();
    const agent = await seed();
    expect(await agents.setMarketListing(agent.id, { listed: true, category: "research" })).toBe(
      false,
    );
    await releases.publish(agent, agent.ownerId);
    expect(await agents.setMarketListing(agent.id, { listed: true, category: "research" })).toBe(
      true,
    );
    const changed = await agents.upsert({
      ...agent,
      name: "New draft",
      marketListed: false,
      marketCategory: "content",
    });
    expect(changed).toMatchObject({
      marketListed: true,
      marketCategory: "research",
      publishedVersion: 1,
    });
    expect((await agents.list({ includeMarket: true })).some((a) => a.id === agent.id)).toBe(true);
    expect(await agents.setMarketListing(agent.id, { listed: true, category: "research" })).toBe(
      true,
    );
  });

  it("unlisting preserves explicit read grants and publication; soft deletion cannot be relisted", async () => {
    const { agents, releases, grants } = repos();
    const agent = await seed();
    await releases.publish(agent, agent.ownerId);
    const grant = await grants.grant({
      id: randomUUID(),
      resourceId: agent.id,
      resourceType: "agent",
      principalType: "*",
      principalId: "*",
      permission: "read",
    });
    expect(await agents.setMarketListing(agent.id, { listed: true, category: "general" })).toBe(
      true,
    );
    expect(await agents.setMarketListing(agent.id, { listed: false, category: "general" })).toBe(
      true,
    );
    expect(await grants.listForResource("agent", agent.id)).toEqual([grant]);
    expect((await agents.get(agent.id))?.publishedVersion).toBe(1);
    expect((await agents.list({ includeMarket: true })).some((a) => a.id === agent.id)).toBe(false);
    await agents.softDelete(agent.id, Date.now());
    expect(await agents.setMarketListing(agent.id, { listed: true, category: "general" })).toBe(
      false,
    );
  });

  it("insert ignores forged market flags and rejects dangling publication pointers", async () => {
    const { agents } = repos();
    const agent = await seed();
    const id = randomUUID().replaceAll("-", "").slice(0, 24);
    ids.add(id);
    const inserted = await agents.upsert({
      ...agent,
      id,
      marketListed: true,
      marketCategory: "content",
    });
    expect(inserted.marketListed).toBe(false);
    expect(inserted.marketCategory).toBeUndefined();
    if (!connection) throw new Error("test database not configured");
    await connection.db
      .update(agentsTable)
      .set({ publishedVersion: 999 })
      .where(eq(agentsTable.id, id));
    expect(await agents.setMarketListing(id, { listed: true, category: "general" })).toBe(false);
  });
});
