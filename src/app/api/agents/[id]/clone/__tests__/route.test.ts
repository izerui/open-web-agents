import { Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: false,
  apiKey: false,
  authenticated: true,
  userId: "cloner",
}));

const upserted: unknown[] = [];
const knowledgeCreated: unknown[] = [];
const knowledgeDeleted: string[] = [];
const softDeleted: string[] = [];
const audited: unknown[] = [];
let createKnowledgeHook: ((doc: unknown, index: number) => void) | null = null;

const sourceAgent = {
  id: "source-agent",
  ownerId: "author",
  name: "Source",
  marketListed: true,
  publishedVersion: 2,
  config: {
    systemPrompt: "Be helpful",
    model: "sonnet" as const,
    maxTurns: 15,
    skillPackages: [{ name: "demo", description: "d", files: { "SKILL.md": "# Demo" } }],
    mcpServers: [
      { type: "http" as const, name: "api", url: "https://api.example.com?token=secret" },
    ],
    starters: ["Hello"],
    inputSchema: { type: "object" },
    escapeHatch: { dangerouslyAllowBash: true },
  },
};

const publishedVersion = {
  agentId: "source-agent",
  version: 2,
  name: "Source Published",
  icon: "🤖",
  description: "A published agent",
  config: sourceAgent.config,
  contentHash: "abc",
  createdBy: "author",
  createdAt: Date.now(),
};

const knowledgeDocs = [
  {
    id: "doc1",
    agentId: "source-agent",
    title: "Lesson 1",
    content: "Content of lesson 1",
    chars: 18,
    searchable: true,
    createdAt: 1000,
  },
  {
    id: "doc2",
    agentId: "source-agent",
    title: "Lesson 2",
    content: "Content of lesson 2",
    chars: 18,
    searchable: true,
    createdAt: 2000,
  },
];

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    agents: {
      get: async (id: string) => (id === "source-agent" ? { ...sourceAgent } : null),
      upsert: async (agent: unknown) => {
        upserted.push(agent);
        return agent;
      },
      softDelete: async (id: string) => {
        softDeleted.push(id);
        return true;
      },
    },
    releases: {
      get: async (agentId: string, version: number) =>
        agentId === "source-agent" && version === 2 ? { ...publishedVersion } : null,
    },
    knowledge: {
      list: async (agentId: string) => ({
        docs: agentId === "source-agent" ? knowledgeDocs : [],
        usage: { docs: 2, chars: 36 },
        limits: { maxDocs: 20, maxCharsPerDoc: 200000 },
      }),
      get: async (id: string) => {
        const doc = knowledgeDocs.find((d) => d.id === id);
        return doc
          ? {
              id: doc.id,
              agentId: doc.agentId,
              title: doc.title,
              content: doc.content,
              createdAt: doc.createdAt,
            }
          : null;
      },
      create: async (doc: unknown) => {
        if (createKnowledgeHook) createKnowledgeHook(doc, knowledgeCreated.length);
        knowledgeCreated.push(doc);
        return doc;
      },
      delete: async (id: string) => {
        knowledgeDeleted.push(id);
      },
    },
    audit: {
      record: async (entry: unknown) => {
        audited.push(entry);
      },
    },
    env: { allowStdioMcp: false },
    auth: {
      resolveWeb: async () => {
        if (!state.authenticated) throw new Unauthorized("login required");
        return state.apiKey
          ? { type: "apiKey" as const, ownerId: state.userId }
          : { type: "web" as const, userId: state.userId, role: state.admin ? "admin" : "user" };
      },
      assertCanManageAgents: (p: { type: string }) => {
        if (p.type !== "web") throw new Forbidden("api keys cannot manage agents");
      },
      subjectOf: async () => ({ userId: state.userId }),
    },
  }),
}));

import { POST } from "../route";

const clone = (id = "source-agent", body: Record<string, unknown> = {}) =>
  POST(
    new Request(`http://test/api/agents/${id}/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("POST /api/agents/{id}/clone", () => {
  beforeEach(() => {
    state.admin = false;
    state.apiKey = false;
    state.authenticated = true;
    state.userId = "cloner";
    upserted.length = 0;
    knowledgeCreated.length = 0;
    knowledgeDeleted.length = 0;
    softDeleted.length = 0;
    audited.length = 0;
    createKnowledgeHook = null;
  });

  it("clones a market-listed agent with published config, redacted MCP, and knowledge docs", async () => {
    const res = await clone();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: Record<string, unknown>; knowledgeCopied: number };
    expect(body.knowledgeCopied).toBe(2);
    expect(body.agent.ownerId).toBe("cloner");
    expect(body.agent.id).not.toBe("source-agent");
    expect(body.agent.name).toBe("Source Published（副本）");
    expect(body.agent.icon).toBe("🤖");
    expect(body.agent.description).toBe("A published agent");

    const config = (body.agent as { config: Record<string, unknown> }).config;
    expect(config.systemPrompt).toBe("Be helpful");
    expect(config.model).toBe("sonnet");
    expect(config.skillPackages).toEqual(sourceAgent.config.skillPackages);
    expect(config.starters).toEqual(["Hello"]);
    expect(config.escapeHatch).toBeUndefined();

    const mcp = (config.mcpServers as { url: string }[])[0];
    expect(mcp.url).not.toContain("token=secret");
    expect(mcp.url).toContain("***");

    expect(knowledgeCreated).toHaveLength(2);
    for (const doc of knowledgeCreated as { agentId: string }[]) {
      expect(doc.agentId).toBe(body.agent.id);
    }

    expect(audited).toHaveLength(1);
    expect((audited[0] as { action: string }).action).toBe("agent.clone");
  });

  it("allows custom name and skipping knowledge copy", async () => {
    const res = await clone("source-agent", { name: "My Custom Agent", includeKnowledge: false });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { name: string }; knowledgeCopied: number };
    expect(body.agent.name).toBe("My Custom Agent");
    expect(body.knowledgeCopied).toBe(0);
    expect(knowledgeCreated).toHaveLength(0);
  });

  it("rejects unauthenticated users", async () => {
    state.authenticated = false;
    expect((await clone()).status).toBe(401);
    expect(upserted).toHaveLength(0);
  });

  it("rejects API key access", async () => {
    state.apiKey = true;
    expect((await clone()).status).toBe(403);
    expect(upserted).toHaveLength(0);
  });

  it("rejects cloning a non-existent agent", async () => {
    expect((await clone("nonexistent")).status).toBe(403);
    expect(upserted).toHaveLength(0);
  });

  it("rejects cloning a system agent", async () => {
    expect((await clone("agent-architect")).status).toBe(404);
    expect(upserted).toHaveLength(0);
  });

  it("rejects cloning an agent not listed on market", async () => {
    sourceAgent.marketListed = false;
    try {
      const res = await clone();
      expect(res.status).toBe(403);
      expect(upserted).toHaveLength(0);
    } finally {
      sourceAgent.marketListed = true;
    }
  });

  it("does not carry over publishedVersion, marketListed, seedHash, or webhookUrl", async () => {
    const res = await clone();
    expect(res.status).toBe(201);
    const agent = ((await res.json()) as { agent: Record<string, unknown> }).agent;
    expect(agent.publishedVersion).toBeUndefined();
    expect(agent.marketListed).toBeUndefined();
    expect(agent.seedHash).toBeUndefined();
    expect(agent.webhookUrl).toBeUndefined();
  });

  it("rolls back agent and first doc when second knowledge doc fails to copy", async () => {
    createKnowledgeHook = (_doc, index) => {
      if (index === 1) throw new Error("simulated write failure");
    };
    const res = await clone();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/知识库复制失败/);
    expect(knowledgeCreated).toHaveLength(1);
    expect(knowledgeDeleted).toHaveLength(1);
    expect(knowledgeDeleted[0]).toBe((knowledgeCreated[0] as { id: string }).id);
    expect(softDeleted).toHaveLength(1);
    expect(audited).toHaveLength(0);
  });
});
