// 知识库仓储对真实 MySQL 的测试(上限调小便于撞线)。未配置 OWA_TEST_DATABASE_URL 时跳过并说明。
//
// 核心回归:曾经列表取最新 500 篇、检索取最早 500 篇,超过上限后两边各看各的。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { knowledgeDocs } from "@/lib/db/schema";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { KnowledgeLimitExceeded } from "@/lib/modules/knowledge/domain/limits";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 知识库仓储 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
  describe.skip("MysqlKnowledgeRepo(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const agents = new MysqlAgentRepo(db);
  const limits = { maxDocs: 3, maxDocChars: 50, maxTotalChars: 100 };
  const repo = new MysqlKnowledgeRepo(db, limits);
  afterAll(async () => {
    await pool.end();
  });

  async function newAgent(): Promise<string> {
    const id = `k${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await agents.upsert({
      id,
      ownerId: "u",
      name: id,
      config: { systemPrompt: "p", model: "sonnet" },
    });
    return id;
  }
  const doc = (agentId: string, content = "内容") => ({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    agentId,
    title: "t",
    content,
  });

  describe("MysqlKnowledgeRepo(真实 MySQL)", () => {
    it("超额旧数据:列表标出的可检索集合与检索实际取到的完全一致(含同一秒写入的文档)", async () => {
      const agentId = await newAgent();
      // 绕过上限直接写入 5 篇,模拟上限设立之前的数据;同一秒写入,只按时间排序是不确定的
      const ids = Array.from({ length: 5 }, () => randomUUID().replace(/-/g, "").slice(0, 24));
      for (const id of ids) {
        await db.insert(knowledgeDocs).values({ id, agentId, title: id, content: `正文 ${id}` });
      }
      const listing = await repo.list(agentId);
      expect(listing.docs).toHaveLength(5); // 不截断
      expect(listing.usage.docs).toBe(5);
      const searchable = listing.docs
        .filter((d) => d.searchable)
        .map((d) => d.id)
        .sort();
      expect(searchable).toHaveLength(3);
      const retrieved = [...new Set((await repo.chunksOf(agentId)).map((c) => c.docId))].sort();
      expect(retrieved).toEqual(searchable);
    });

    it("写入时拦住超限:篇数、总字数、单篇长度", async () => {
      const a1 = await newAgent();
      for (let i = 0; i < 3; i++) await repo.create(doc(a1));
      await expect(repo.create(doc(a1))).rejects.toBeInstanceOf(KnowledgeLimitExceeded);

      const a2 = await newAgent();
      await repo.create(doc(a2, "字".repeat(50)));
      await repo.create(doc(a2, "字".repeat(45)));
      await expect(repo.create(doc(a2, "字".repeat(10)))).rejects.toThrow(/合计/);

      const a3 = await newAgent();
      await expect(repo.create(doc(a3, "字".repeat(51)))).rejects.toThrow(/单篇/);
      expect((await repo.list(a3)).usage.docs).toBe(0);
    });

    it("并发上传:恰好上限那么多篇成功,其余被拒", { timeout: 30_000 }, async () => {
      const agentId = await newAgent();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repo.create(doc(agentId))),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(KnowledgeLimitExceeded);
      }
      expect((await repo.list(agentId)).usage.docs).toBe(3);
    });
  });
}
