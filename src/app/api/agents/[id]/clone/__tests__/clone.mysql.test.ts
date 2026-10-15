import { randomUUID } from "node:crypto";
import { type Db, createDb } from "@/lib/db/client";
import { agents, knowledgeDocs } from "@/lib/db/schema";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.OWA_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/owa_test") {
  throw new Error("Clone SQL tests require the dedicated owa_test database");
}

if (!url) {
  describe.skip("clone transaction atomicity (requires owa_test)", () => {
    it("not configured", () => {});
  });
} else {
  const { db, pool } = createDb(url);
  const createdAgentIds = new Set<string>();

  afterAll(async () => {
    try {
      for (const id of createdAgentIds) {
        await db.delete(knowledgeDocs).where(eq(knowledgeDocs.agentId, id));
        await db.delete(agents).where(eq(agents.id, id));
      }
    } finally {
      await pool.end();
    }
  });

  function agentId() {
    const id = `clone-test-${randomUUID().slice(0, 16)}`;
    createdAgentIds.add(id);
    return id;
  }

  const minConfig = { systemPrompt: "test", model: "sonnet" as const, maxTurns: 5 };

  describe("clone transaction atomicity", () => {
    it("successful clone creates agent and all knowledge docs atomically", async () => {
      const sourceId = agentId();
      const cloneId = agentId();
      const agentRepo = new MysqlAgentRepo(db);
      const knowledgeRepo = new MysqlKnowledgeRepo(db);

      await agentRepo.upsert({
        id: sourceId,
        ownerId: "author",
        name: "Source",
        config: minConfig,
      });
      await knowledgeRepo.create({
        id: randomUUID().slice(0, 24),
        agentId: sourceId,
        title: "Doc A",
        content: "AAA",
      });
      await knowledgeRepo.create({
        id: randomUUID().slice(0, 24),
        agentId: sourceId,
        title: "Doc B",
        content: "BBB",
      });

      const sourceDocs = (await knowledgeRepo.list(sourceId)).docs;

      await db.transaction(async (tx) => {
        const txAgents = new MysqlAgentRepo(tx as unknown as Db);
        await txAgents.upsert({ id: cloneId, ownerId: "cloner", name: "Clone", config: minConfig });

        const txKnowledge = new MysqlKnowledgeRepo(tx as unknown as Db);
        for (const item of sourceDocs) {
          const doc = await knowledgeRepo.get(item.id);
          if (!doc) throw new Error("source doc missing");
          await txKnowledge.create({
            id: randomUUID().slice(0, 24),
            agentId: cloneId,
            title: doc.title,
            content: doc.content,
          });
        }
      });

      const cloned = await agentRepo.get(cloneId);
      expect(cloned).not.toBeNull();
      expect(cloned?.name).toBe("Clone");
      const clonedDocs = (await knowledgeRepo.list(cloneId)).docs;
      expect(clonedDocs).toHaveLength(2);
      expect(clonedDocs.map((d) => d.title).sort()).toEqual(["Doc A", "Doc B"]);
    });

    it("second doc write failure rolls back agent AND first doc — no residue in database", async () => {
      const sourceId = agentId();
      const cloneId = agentId();
      const agentRepo = new MysqlAgentRepo(db);
      const knowledgeRepo = new MysqlKnowledgeRepo(db);

      await agentRepo.upsert({
        id: sourceId,
        ownerId: "author",
        name: "Source",
        config: minConfig,
      });
      await knowledgeRepo.create({
        id: randomUUID().slice(0, 24),
        agentId: sourceId,
        title: "Doc 1",
        content: "First",
      });
      await knowledgeRepo.create({
        id: randomUUID().slice(0, 24),
        agentId: sourceId,
        title: "Doc 2",
        content: "Second",
      });

      const sourceDocs = (await knowledgeRepo.list(sourceId)).docs;
      let firstDocWritten = false;

      await expect(
        db.transaction(async (tx) => {
          const txAgents = new MysqlAgentRepo(tx as unknown as Db);
          await txAgents.upsert({
            id: cloneId,
            ownerId: "cloner",
            name: "Clone",
            config: minConfig,
          });

          const txKnowledge = new MysqlKnowledgeRepo(tx as unknown as Db);
          for (const [i, item] of sourceDocs.entries()) {
            const doc = await knowledgeRepo.get(item.id);
            if (!doc) throw new Error("source doc missing");
            if (i === 1) {
              firstDocWritten = true;
              throw new Error("simulated second doc failure");
            }
            await txKnowledge.create({
              id: randomUUID().slice(0, 24),
              agentId: cloneId,
              title: doc.title,
              content: doc.content,
            });
          }
        }),
      ).rejects.toThrow("simulated second doc failure");

      expect(firstDocWritten).toBe(true);

      const clonedAgent = await db.select().from(agents).where(eq(agents.id, cloneId)).limit(1);
      expect(clonedAgent).toEqual([]);

      const clonedDocs = await db
        .select()
        .from(knowledgeDocs)
        .where(eq(knowledgeDocs.agentId, cloneId));
      expect(clonedDocs).toEqual([]);

      expect(await agentRepo.get(cloneId)).toBeNull();

      const sourceStillExists = await agentRepo.get(sourceId);
      expect(sourceStillExists).not.toBeNull();
      const sourceDocsStill = (await knowledgeRepo.list(sourceId)).docs;
      expect(sourceDocsStill).toHaveLength(2);
    });

    it("agent upsert failure inside transaction leaves no knowledge docs", async () => {
      const sourceId = agentId();
      const cloneId = agentId();
      const agentRepo = new MysqlAgentRepo(db);
      const knowledgeRepo = new MysqlKnowledgeRepo(db);

      await agentRepo.upsert({
        id: sourceId,
        ownerId: "author",
        name: "Source",
        config: minConfig,
      });
      await knowledgeRepo.create({
        id: randomUUID().slice(0, 24),
        agentId: sourceId,
        title: "Doc X",
        content: "X",
      });

      await expect(
        db.transaction(async (tx) => {
          const txAgents = new MysqlAgentRepo(tx as unknown as Db);
          await txAgents.upsert({
            id: cloneId,
            ownerId: "cloner",
            name: "Clone",
            config: minConfig,
          });
          throw new Error("simulated agent post-processing failure");
        }),
      ).rejects.toThrow("simulated agent post-processing failure");

      const clonedAgent = await db.select().from(agents).where(eq(agents.id, cloneId)).limit(1);
      expect(clonedAgent).toEqual([]);
    });
  });
}
