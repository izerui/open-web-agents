import {
  type Principal,
  agentAccessLevel,
  canInvokeAgent,
} from "@/lib/modules/access/domain/principal";
import { describe, expect, it } from "vitest";
import { fixture, publishedAgent } from "./fixture";

const admin: Principal = { type: "web", userId: "admin", role: "admin" };
const user: Principal = { type: "web", userId: "customer", role: "user" };
const subject = { userId: "customer", role: "user" as const };
const listing = { listed: true, category: "research" };

describe("market use-only catalog", () => {
  it("lists only published market resources and searches published text, never drafts", async () => {
    const h = await fixture();
    expect(await h.market.list(user, subject, [])).toEqual([]);
    await h.market.setListing(admin, publishedAgent.id, listing);
    expect(
      await h.market.list(user, subject, [], { search: "published", category: "research" }),
    ).toHaveLength(1);
    expect(await h.market.list(user, subject, [], { search: "Draft secret" })).toEqual([]);
    expect(await h.market.list(user, subject, [], { category: "content" })).toEqual([]);
    await expect(h.market.list(user, subject, [], { category: "made-up" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("exports a whitelist with contracts/starters/model and no definitions or credentials", async () => {
    const h = await fixture();
    await h.market.setListing(admin, publishedAgent.id, listing);
    const view = await h.market.detail(user, subject, [], publishedAgent.id);
    expect(view).toMatchObject({
      name: publishedAgent.name,
      publishedVersion: 1,
      canRead: false,
      config: {
        model: "sonnet",
        inputSchema: publishedAgent.config.inputSchema,
        outputSchema: publishedAgent.config.outputSchema,
        starters: ["Public starter"],
      },
    });
    for (const key of [
      "systemPrompt",
      "skillPackages",
      "mcpServers",
      "escapeHatch",
      "tools",
      "subagents",
    ]) {
      expect(view.config).not.toHaveProperty(key);
    }
    expect(view).not.toHaveProperty("ownerId");
    expect(view).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify(view)).not.toMatch(/secret|private-|Draft/);
  });

  it("grants invocation without granting read/write, including API keys", async () => {
    const h = await fixture();
    await h.market.setListing(admin, publishedAgent.id, listing);
    const a = await h.agents.get(publishedAgent.id);
    if (!a) throw new Error("missing agent");
    expect(canInvokeAgent(user, a, subject, []).allowed).toBe(true);
    expect(agentAccessLevel(user, a, subject, [])).toBe("none");
    const key: Principal = { type: "apiKey", keyId: "key", ownerId: subject.userId, agentId: a.id };
    expect(canInvokeAgent(key, a, subject, []).allowed).toBe(true);
    expect(agentAccessLevel(key, a, subject, [])).toBe("none");
    expect(canInvokeAgent({ ...key, agentId: "different" }, a, subject, []).allowed).toBe(false);
    await h.auth.assertCanInvoke(user, a.id);
  });

  it("unlisting stops new invocation but does not revoke existing read grants or erase history", async () => {
    const h = await fixture();
    await h.market.setListing(admin, publishedAgent.id, listing);
    await h.sessions.create({
      id: "history",
      agentId: publishedAgent.id,
      ownerId: subject.userId,
      workspaceDir: "/unused",
    });
    await h.market.setListing(admin, publishedAgent.id, { ...listing, listed: false });
    await expect(h.auth.assertCanInvoke(user, publishedAgent.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(h.market.detail(user, subject, [], publishedAgent.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await h.sessions.get("history")).not.toBeNull();
    await h.auth.assertSessionAccess(user, "history");
    const grant = await h.grants.grant({
      id: "public-read",
      resourceId: publishedAgent.id,
      resourceType: "agent",
      principalType: "*",
      principalId: "*",
      permission: "read",
    });
    await h.market.setListing(admin, publishedAgent.id, listing);
    await h.market.setListing(admin, publishedAgent.id, { ...listing, listed: false });
    expect(await h.grants.listForType("agent")).toEqual([grant]);
    await h.auth.assertCanInvoke(user, publishedAgent.id);
    const a = await h.agents.get(publishedAgent.id);
    if (!a) throw new Error("missing agent");
    expect(agentAccessLevel(user, a, subject, [grant])).toBe("read");
  });

  it.each([
    { type: "web", userId: "owner", role: "user" },
    { type: "apiKey", keyId: "admin-key", ownerId: "admin" },
  ] as Principal[])("rejects non-admin or API-key listing management %#", async (principal) => {
    const h = await fixture();
    await expect(h.market.setListing(principal, publishedAgent.id, listing)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      h.market.list(principal, { userId: "admin", role: "admin" }, [], { manage: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not list an unpublished or private system executor even for admins", async () => {
    const h = await fixture();
    await h.agents.upsert({ ...publishedAgent, id: "unpublished" });
    await h.agents.upsert({ ...publishedAgent, id: "agent-architect" });
    await h.releases.publish({ ...publishedAgent, id: "agent-architect" }, "admin");
    await expect(h.market.setListing(admin, "unpublished", listing)).rejects.toMatchObject({
      code: "not_published",
    });
    await expect(h.market.setListing(admin, "agent-architect", listing)).rejects.toMatchObject({
      status: 404,
    });
    const candidates = await h.market.list(admin, { userId: "admin", role: "admin" }, [], {
      manage: true,
    });
    expect(candidates.map((a) => a.id)).toEqual([publishedAgent.id]);
    expect(await h.agents.setMarketListing("agent-architect", listing)).toBe(false);
  });

  it("ordinary upsert cannot set or clear market metadata, including on first insert", async () => {
    const h = await fixture();
    const fresh = await h.agents.upsert({
      ...publishedAgent,
      id: "new",
      marketListed: true,
      marketCategory: "content",
    });
    expect(fresh.marketListed).toBe(false);
    expect(fresh.marketCategory).toBeUndefined();
    await h.market.setListing(admin, publishedAgent.id, listing);
    const saved = await h.agents.upsert({
      ...publishedAgent,
      marketListed: false,
      marketCategory: "content",
    });
    expect(saved).toMatchObject({
      marketListed: true,
      marketCategory: "research",
      publishedVersion: 1,
    });
  });

  it.each([
    null,
    [],
    {},
    { listed: "true", category: "research" },
    { listed: true, category: "invalid" },
    { ...listing, ownerId: "attacker" },
  ])("rejects invalid management payload %#", async (raw) => {
    const h = await fixture();
    await expect(h.market.setListing(admin, publishedAgent.id, raw)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("missing published snapshots and deleted agents are never returned", async () => {
    const h = await fixture();
    await h.market.setListing(admin, publishedAgent.id, listing);
    h.agents.setPublished(publishedAgent.id, 999, "missing");
    expect(await h.market.list(user, subject, [])).toEqual([]);
    await expect(h.market.detail(user, subject, [], publishedAgent.id)).rejects.toMatchObject({
      status: 404,
    });
    await h.agents.softDelete(publishedAgent.id, Date.now());
    expect(
      await h.market.list(admin, { userId: "admin", role: "admin" }, [], { manage: true }),
    ).toEqual([]);
  });
});
