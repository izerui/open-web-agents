import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChunkCache } from "../../application/chunk-cache";
import type { Chunk } from "../../domain/retrieval";
import { chunkText, retrieve } from "../../domain/retrieval";

class FakeKnowledgeRepo {
  private docs = new Map<
    string,
    { agentId: string; title: string; content: string; revision: number }
  >();

  async create(agentId: string, title: string, content: string) {
    const id = randomUUID().slice(0, 24);
    this.docs.set(id, { agentId, title, content, revision: 0 });
    return id;
  }

  async update(id: string, data: { title?: string; content?: string }) {
    const doc = this.docs.get(id);
    if (!doc) return;
    if (data.title !== undefined) doc.title = data.title;
    if (data.content !== undefined) doc.content = data.content;
    doc.revision += 1;
  }

  async signatureOf(agentId: string): Promise<string> {
    const docs = [...this.docs.entries()].filter(([, d]) => d.agentId === agentId);
    const totalRev = docs.reduce((s, [, d]) => s + d.revision, 0);
    return `${docs.length}:${totalRev}:${docs.length}`;
  }

  async chunksOf(agentId: string): Promise<Chunk[]> {
    const docs = [...this.docs.entries()].filter(([, d]) => d.agentId === agentId);
    const out: Chunk[] = [];
    for (const [id, d] of docs) {
      for (const [i, text] of chunkText(d.content).entries()) {
        out.push({ docId: id, docTitle: d.title, index: i, text });
      }
    }
    return out;
  }
}

describe("knowledge cache invalidation on edit", () => {
  it("editing content changes signature and cache returns new content", async () => {
    const repo = new FakeKnowledgeRepo();
    const cache = new ChunkCache(repo);
    const agentId = "agent-1";

    const docId = await repo.create(agentId, "Lesson 1", "Original content about binary trees");

    // First retrieval — populates cache
    const chunks1 = await cache.chunksOf(agentId);
    expect(chunks1.length).toBeGreaterThan(0);
    const result1 = retrieve("binary trees", chunks1);
    expect(result1.some((c) => c.text.includes("Original content"))).toBe(true);

    // Edit the document
    await repo.update(docId, { content: "Updated content about hash tables" });

    // Second retrieval — cache should be invalidated by changed signature
    const chunks2 = await cache.chunksOf(agentId);
    const result2 = retrieve("hash tables", chunks2);
    expect(result2.some((c) => c.text.includes("Updated content"))).toBe(true);
    expect(result2.some((c) => c.text.includes("Original content"))).toBe(false);
  });

  it("editing title changes signature and updates chunk metadata", async () => {
    const repo = new FakeKnowledgeRepo();
    const cache = new ChunkCache(repo);
    const agentId = "agent-2";

    const docId = await repo.create(agentId, "Old Title", "Some lesson content");

    const chunks1 = await cache.chunksOf(agentId);
    expect(chunks1[0]?.docTitle).toBe("Old Title");

    await repo.update(docId, { title: "New Title" });

    const chunks2 = await cache.chunksOf(agentId);
    expect(chunks2[0]?.docTitle).toBe("New Title");
  });
});
