import { randomUUID } from "node:crypto";
import { type Db, createDb } from "@/lib/db/client";
import { agentVersions, agents, knowledgeDocs } from "@/lib/db/schema";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import { UNGATED } from "@/lib/modules/agent/application/__tests__/ungated";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.OWA_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/owa_test") {
  throw new Error("Clone SQL tests require the dedicated owa_test database");
}

if (!url) {
  describe.skip("clone route MySQL atomicity (requires owa_test)", () => {
    it("not configured", () => {});
  });
} else {
  const { db, pool } = createDb(url);
  const agentRepo = new MysqlAgentRepo(db);
  const knowledgeRepo = new MysqlKnowledgeRepo(db);
  const releases = new AgentReleases(agentRepo, new MysqlAgentVersionRepo(db), UNGATED);
  const cleanupIds = new Set<string>();

  function trackId(id?: string) {
    const v = id ?? `ct-${randomUUID().slice(0, 20)}`;
    cleanupIds.add(v);
    return v;
  }

  const minConfig = { systemPrompt: "clone test", model: "sonnet" as const, maxTurns: 5 };

  // Mock only auth/audit/env; use real db, agents, knowledge, releases.
  vi.mock("@/lib/container", () => ({
    getContainer: () => {
      // Access real instances via globalThis (set in beforeAll)
      const g = globalThis as Record<string, unknown>;
      return {
        db: g._testDb,
        agents: g._testAgentRepo,
        knowledge: g._testKnowledgeRepo,
        releases: g._testReleases,
        knowledgeWriterFactory: (txDb: unknown) => new MysqlKnowledgeRepo(txDb as Db),
        audit: { record: async () => {} },
        env: { allowStdioMcp: false },
        auth: {
          resolveWeb: async () => ({ type: "web" as const, userId: "cloner", role: "user" }),
          assertCanManageAgents: () => {},
          subjectOf: async () => ({ userId: "cloner" }),
        },
      };
    },
  }));

  beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    g._testDb = db;
    g._testAgentRepo = agentRepo;
    g._testKnowledgeRepo = knowledgeRepo;
    g._testReleases = releases;
  });

  afterAll(async () => {
    try {
      for (const id of cleanupIds) {
        await db.delete(knowledgeDocs).where(eq(knowledgeDocs.agentId, id));
        await db.delete(agentVersions).where(eq(agentVersions.agentId, id));
        await db.delete(agents).where(eq(agents.id, id));
      }
    } finally {
      await pool.end();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupSource() {
    const sourceId = trackId();
    await agentRepo.upsert({
      id: sourceId,
      ownerId: "author",
      name: "Source Agent",
      config: minConfig,
    });
    const agent = await agentRepo.get(sourceId);
    if (!agent) throw new Error("source agent not created");
    await releases.publish(agent, "author");
    await agentRepo.setMarketListing(sourceId, { listed: true, category: "general" });
    await knowledgeRepo.create({
      id: randomUUID().slice(0, 24),
      agentId: sourceId,
      title: "Lesson 1",
      content: "First lesson content",
    });
    await knowledgeRepo.create({
      id: randomUUID().slice(0, 24),
      agentId: sourceId,
      title: "Lesson 2",
      content: "Second lesson content",
    });
    return sourceId;
  }

  async function callClone(sourceId: string) {
    const { POST } = await import("../route");
    return POST(
      new Request(`http://test/api/agents/${sourceId}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: sourceId }) },
    );
  }

  describe("clone route MySQL atomicity", () => {
    it("successful POST creates agent and docs in the real database", async () => {
      const sourceId = await setupSource();
      const res = await callClone(sourceId);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { agent: { id: string }; knowledgeCopied: number };
      trackId(body.agent.id);
      expect(body.knowledgeCopied).toBe(2);

      const cloned = await agentRepo.get(body.agent.id);
      expect(cloned).not.toBeNull();
      expect(cloned?.ownerId).toBe("cloner");
      const docs = (await knowledgeRepo.list(body.agent.id)).docs;
      expect(docs).toHaveLength(2);
      expect(docs.map((d) => d.title).sort()).toEqual(["Lesson 1", "Lesson 2"]);
    });

    it("POST returns 500 and leaves no residue when second doc write fails inside the route's transaction", async () => {
      const sourceId = await setupSource();

      // Snapshot agent count before clone attempt
      const beforeAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.ownerId, "cloner"));
      const beforeCount = beforeAgents.length;

      const original = MysqlKnowledgeRepo.prototype.create;
      let createCalls = 0;
      let cloneTargetAgentId: string | undefined;
      vi.spyOn(MysqlKnowledgeRepo.prototype, "create").mockImplementation(async function (
        this: MysqlKnowledgeRepo,
        input,
      ) {
        createCalls++;
        cloneTargetAgentId ??= (input as { agentId: string }).agentId;
        if (createCalls === 2) throw new Error("injected failure on second doc");
        return original.call(this, input);
      });

      const res = await callClone(sourceId);
      expect(res.status).toBe(500);
      expect(createCalls).toBe(2);
      expect(cloneTargetAgentId).toBeTruthy();
      const targetId = cloneTargetAgentId as string;
      trackId(targetId);

      // No new agents created by cloner
      const afterAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.ownerId, "cloner"));
      expect(afterAgents.length).toBe(beforeCount);

      // No residual agent or docs for the clone target ID
      const residualAgent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, targetId));
      expect(residualAgent).toEqual([]);

      const residualDocs = await db
        .select({ id: knowledgeDocs.id })
        .from(knowledgeDocs)
        .where(eq(knowledgeDocs.agentId, targetId));
      expect(residualDocs).toEqual([]);

      // Source is untouched
      const source = await agentRepo.get(sourceId);
      expect(source).not.toBeNull();
      expect((await knowledgeRepo.list(sourceId)).docs).toHaveLength(2);
    });
  });
}
