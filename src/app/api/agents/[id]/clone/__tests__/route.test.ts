import { Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: false,
  apiKey: false,
  authenticated: true,
  userId: "cloner",
}));

const audited: unknown[] = [];
let transactionResult: unknown = null;
let transactionError: Error | null = null;
let knowledgeGetOverride: ((id: string) => unknown) | null = null;

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
      { type: "http" as const, name: "api", url: "https://{{BASE_URL}}/v1?token={{API_KEY}}" },
      {
        type: "stdio" as const,
        name: "tool",
        command: "node",
        args: ["run.js"],
        env: { KEY: "{{API_KEY}}", HOST: "hardcoded-secret" },
      },
    ],
    starters: ["Hello"],
    inputSchema: { type: "object" },
    escapeHatch: { dangerouslyAllowBash: true },
    variables: [
      { name: "API_KEY", description: "密钥", required: true, secret: true },
      { name: "BASE_URL", description: "地址", required: true, secret: false },
    ],
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

vi.mock("@/lib/modules/agent/adapters/mysql-agent-repo", () => ({
  MysqlAgentRepo: vi.fn().mockImplementation(() => ({
    upsert: async (agent: unknown) => agent,
  })),
}));

vi.mock("@/lib/modules/knowledge/adapters/mysql-knowledge-repo", () => ({
  MysqlKnowledgeRepo: vi.fn().mockImplementation(() => ({
    create: async (doc: unknown) => doc,
  })),
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    agents: {
      get: async (id: string) => (id === "source-agent" ? { ...sourceAgent } : null),
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
        if (knowledgeGetOverride) return knowledgeGetOverride(id);
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
    },
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        if (transactionError) throw transactionError;
        const result = await fn({});
        transactionResult = result;
        return result;
      },
    },
    knowledgeWriterFactory: () => ({
      create: async (doc: unknown) => doc,
    }),
    audit: {
      record: async (entry: unknown) => {
        audited.push(entry);
      },
    },
    env: { allowStdioMcp: true },
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
    audited.length = 0;
    transactionResult = null;
    transactionError = null;
    knowledgeGetOverride = null;
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

    const mcpServers = config.mcpServers as {
      name: string;
      url?: string;
      env?: Record<string, string>;
    }[];
    const httpMcp = mcpServers.find((m) => m.name === "api");
    expect(httpMcp?.url).toContain("{{BASE_URL}}");
    expect(httpMcp?.url).toContain("{{API_KEY}}");

    const stdioMcp = mcpServers.find((m) => m.name === "tool");
    expect(stdioMcp?.env?.KEY).toBe("{{API_KEY}}");
    expect(stdioMcp?.env?.HOST).toBe("***");

    expect((config.variables as unknown[])?.length).toBe(2);

    expect(audited).toHaveLength(1);
    expect((audited[0] as { action: string }).action).toBe("agent.clone");
  });

  it("allows custom name and skipping knowledge copy", async () => {
    const res = await clone("source-agent", { name: "My Custom Agent", includeKnowledge: false });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { name: string }; knowledgeCopied: number };
    expect(body.agent.name).toBe("My Custom Agent");
    expect(body.knowledgeCopied).toBe(0);
  });

  it("rejects unauthenticated users", async () => {
    state.authenticated = false;
    expect((await clone()).status).toBe(401);
    expect(transactionResult).toBeNull();
  });

  it("rejects API key access", async () => {
    state.apiKey = true;
    expect((await clone()).status).toBe(403);
    expect(transactionResult).toBeNull();
  });

  it("rejects cloning a non-existent agent", async () => {
    expect((await clone("nonexistent")).status).toBe(403);
    expect(transactionResult).toBeNull();
  });

  it("rejects cloning a system agent", async () => {
    expect((await clone("agent-architect")).status).toBe(404);
    expect(transactionResult).toBeNull();
  });

  it("rejects cloning an agent not listed on market", async () => {
    sourceAgent.marketListed = false;
    try {
      const res = await clone();
      expect(res.status).toBe(403);
      expect(transactionResult).toBeNull();
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

  it("aborts before transaction when knowledge doc read fails", async () => {
    knowledgeGetOverride = (id: string) => {
      if (id === "doc2") return null;
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
    };
    const res = await clone();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: /Lesson 2/ });
    expect(transactionResult).toBeNull();
    expect(audited).toHaveLength(0);
  });
});
