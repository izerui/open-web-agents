import { Authorizer } from "@/lib/modules/access/application/authorize";
import type { Grant } from "@/lib/modules/access/domain/grants";
import type { GrantRepo } from "@/lib/modules/access/ports";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { catalogView } from "@/lib/modules/agent/domain/__tests__/model-catalog";
import type { Agent } from "@/lib/modules/agent/ports";
import type { ApiKeyRepo, NewApiKey } from "@/lib/modules/identity/ports";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { vi } from "vitest";
import { AgentMarket } from "../application/catalog";

export const publishedAgent: Agent = {
  id: "market-agent",
  ownerId: "owner",
  name: "Published researcher",
  description: "Published description",
  webhookUrl: "https://private-hook.example?secret=hook-secret",
  config: {
    model: "sonnet",
    systemPrompt: "private-system-prompt",
    skillPackages: [
      {
        name: "internal",
        description: "Internal skill",
        files: { "SKILL.md": "private-skill-source", "scripts/run.sh": "private-script" },
      },
    ],
    mcpServers: [
      { name: "private", type: "http", url: "https://private-mcp.example?secret=mcp-secret" },
    ],
    escapeHatch: { private: "hatch-secret" },
    starters: ["Public starter"],
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  },
};

export async function fixture() {
  const agents = new InMemoryAgentRepo([publishedAgent]);
  const versions = new InMemoryAgentVersionRepo(agents);
  const releases = new AgentReleases(agents, versions);
  await releases.publish(publishedAgent, "owner");
  await agents.upsert({
    ...publishedAgent,
    name: "Draft secret name",
    description: "Draft secret description",
    config: { ...publishedAgent.config, systemPrompt: "unpublished-secret" },
  });
  const sessions = new InMemorySessionRepo();
  let entries: Grant[] = [];
  const grants: GrantRepo = {
    listForResource: async (_, id) => entries.filter((g) => g.resourceId === id),
    listForType: async () => [...entries],
    grant: async (grant) => {
      entries = [...entries.filter((g) => g.id !== grant.id), grant];
      return grant;
    },
    revoke: async (id) => {
      entries = entries.filter((g) => g.id !== id);
    },
    revokeAllForResource: async (_, id) => {
      entries = entries.filter((g) => g.resourceId !== id);
    },
  };
  const keys = new Map<string, NewApiKey & { createdAt: number }>();
  const apiKeys: ApiKeyRepo = {
    create: async (key) => {
      const row = { ...key, createdAt: Date.now() };
      keys.set(key.id, row);
      return row;
    },
    findByHash: async (hash) => [...keys.values()].find((key) => key.hashedKey === hash) ?? null,
    get: async (id) => keys.get(id) ?? null,
    list: async (ownerId) => [...keys.values()].filter((key) => key.ownerId === ownerId),
    revoke: async (id) => {
      keys.delete(id);
    },
    setRateLimit: async () => {},
    setMonthlyLimit: async () => {},
    setExpiry: async (id, at) => {
      const key = keys.get(id);
      if (key) key.expiresAt = at ?? undefined;
    },
    touch: async () => {},
  };
  const auth = new Authorizer({
    agents,
    sessions,
    grants,
    apiKeys,
    authRequired: true,
    currentUser: async (req) => {
      const id = req.headers.get("x-test-user");
      return id ? { id, role: id === "admin" ? "admin" : "user" } : null;
    },
  });
  return {
    agents,
    versions,
    releases,
    sessions,
    grants,
    apiKeys,
    auth,
    market: new AgentMarket(agents, releases),
    audit: {
      record: vi.fn(async () => {}),
    },
    env: { dataDir: "/unused-market-test", allowStdioMcp: false, invokeRateLimitPerKey: 60 },
    modelCatalogView: async () => catalogView(),
  };
}
