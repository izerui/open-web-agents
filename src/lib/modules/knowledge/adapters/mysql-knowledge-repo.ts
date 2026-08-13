import type { Db } from "@/lib/db/client";
import { knowledgeDocs } from "@/lib/db/schema";
import { type Chunk, chunkText } from "@/lib/modules/knowledge/domain/retrieval";
import { desc, eq } from "drizzle-orm";

export interface KnowledgeDoc {
  id: string;
  agentId: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface NewKnowledgeDoc {
  id: string;
  agentId: string;
  title: string;
  content: string;
}

export class MysqlKnowledgeRepo {
  constructor(private readonly db: Db) {}

  async create(d: NewKnowledgeDoc): Promise<KnowledgeDoc> {
    await this.db.insert(knowledgeDocs).values(d);
    const got = await this.get(d.id);
    if (!got) throw new Error(`knowledge doc insert failed: ${d.id}`);
    return got;
  }

  async get(id: string): Promise<KnowledgeDoc | null> {
    const rows = await this.db
      .select()
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, id))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          id: r.id,
          agentId: r.agentId,
          title: r.title,
          content: r.content,
          createdAt: r.createdAt.getTime(),
        }
      : null;
  }

  /** 列出智能体的知识文档。不带正文 —— 列表页不需要,省带宽。 */
  async list(agentId: string): Promise<Omit<KnowledgeDoc, "content">[]> {
    const rows = await this.db
      .select({
        id: knowledgeDocs.id,
        agentId: knowledgeDocs.agentId,
        title: knowledgeDocs.title,
        createdAt: knowledgeDocs.createdAt,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.agentId, agentId))
      .orderBy(desc(knowledgeDocs.createdAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      title: r.title,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id));
  }

  /**
   * 取该智能体全部文档并切成片段,供检索。
   *
   * 切块在读取时算而非入库时算:文档量级不大时,省掉"改文档要同步重建索引"这层
   * 一致性维护;真正的规模化再换带持久索引的实现(检索接口不变)。
   */
  async chunksOf(agentId: string): Promise<Chunk[]> {
    const rows = await this.db
      .select({
        id: knowledgeDocs.id,
        title: knowledgeDocs.title,
        content: knowledgeDocs.content,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.agentId, agentId))
      // 必须定序:无序截断会让"文档超过 500 篇后哪些对检索可见"变得不可预测,
      // 同一个问题在不同请求下得到不同答案,无报错无日志
      .orderBy(knowledgeDocs.createdAt)
      .limit(500);

    const out: Chunk[] = [];
    for (const r of rows) {
      for (const [i, text] of chunkText(r.content).entries()) {
        out.push({ docId: r.id, docTitle: r.title, index: i, text });
      }
    }
    return out;
  }
}
