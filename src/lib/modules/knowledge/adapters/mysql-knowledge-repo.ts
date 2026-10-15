import type { Db } from "@/lib/db/client";
import { knowledgeDocs } from "@/lib/db/schema";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeLimitExceeded,
  type KnowledgeLimits,
  limitViolation,
} from "@/lib/modules/knowledge/domain/limits";
import { type Chunk, chunkText } from "@/lib/modules/knowledge/domain/retrieval";
import { asc, eq, sql } from "drizzle-orm";

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

export interface KnowledgeListItem extends Omit<KnowledgeDoc, "content"> {
  chars: number;
  /** 是否参与检索:按 (创建时间, id) 升序的前 maxDocs 篇 */
  searchable: boolean;
}

export interface KnowledgeListing {
  /** 新的在前(展示顺序) */
  docs: KnowledgeListItem[];
  usage: { docs: number; chars: number };
  limits: KnowledgeLimits;
}

export class MysqlKnowledgeRepo {
  constructor(
    private readonly db: Db,
    private readonly limits: KnowledgeLimits = KNOWLEDGE_LIMITS,
  ) {}

  /**
   * 新增一篇。超限抛 KnowledgeLimitExceeded。
   * 计数与插入在同一事务里、先锁住智能体那一行:并发上传不能各自看到"还差一篇"而一起越过上限。
   */
  async create(d: NewKnowledgeDoc): Promise<KnowledgeDoc> {
    await this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT id FROM agents WHERE id = ${d.agentId} LIMIT 1 FOR UPDATE`,
      );
      const lockedRows = (locked as unknown as [unknown[]])[0];
      if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
        throw new Error(`agent not found: ${d.agentId}`);
      }
      const [u] = await tx
        .select({
          docs: sql<number>`COUNT(*)`,
          chars: sql<number>`COALESCE(SUM(CHAR_LENGTH(${knowledgeDocs.content})), 0)`,
        })
        .from(knowledgeDocs)
        .where(eq(knowledgeDocs.agentId, d.agentId));
      const reason = limitViolation(
        { docs: Number(u?.docs ?? 0), chars: Number(u?.chars ?? 0) },
        [...d.content].length,
        this.limits,
      );
      if (reason) throw new KnowledgeLimitExceeded(reason);
      await tx.insert(knowledgeDocs).values(d);
    });
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

  /**
   * 列出智能体的全部知识文档(不带正文),并标出哪些参与检索。
   * 不截断:写入时已有上限;上限之前的超额旧数据也要列出来并标为"不参与检索",
   * 否则用户不知道为什么有的文档不起作用。
   */
  async list(agentId: string): Promise<KnowledgeListing> {
    const rows = await this.db
      .select({
        id: knowledgeDocs.id,
        agentId: knowledgeDocs.agentId,
        title: knowledgeDocs.title,
        createdAt: knowledgeDocs.createdAt,
        chars: sql<number>`CHAR_LENGTH(${knowledgeDocs.content})`,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.agentId, agentId))
      // 与 chunksOf 同一个顺序 —— 两边对"哪些可检索"的判定必须一致
      .orderBy(asc(knowledgeDocs.createdAt), asc(knowledgeDocs.id));
    const items = rows.map((r, i) => ({
      id: r.id,
      agentId: r.agentId,
      title: r.title,
      createdAt: r.createdAt.getTime(),
      chars: Number(r.chars),
      searchable: i < this.limits.maxDocs,
    }));
    return {
      docs: items.reverse(),
      usage: { docs: items.length, chars: items.reduce((n, d) => n + d.chars, 0) },
      limits: this.limits,
    };
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id));
  }

  async update(
    id: string,
    data: { title?: string; content?: string },
  ): Promise<KnowledgeDoc | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`SELECT id, agent_id, title, content, created_at
            FROM knowledge_docs WHERE id = ${id} LIMIT 1 FOR UPDATE`,
      );
      const locked = (rows as unknown as [unknown[]])[0];
      if (!Array.isArray(locked) || locked.length === 0) return null;
      const existing = locked[0] as {
        id: string;
        agent_id: string;
        title: string;
        content: string;
      };

      await tx.execute(
        sql`SELECT id FROM agents WHERE id = ${existing.agent_id} LIMIT 1 FOR UPDATE`,
      );

      const newContent = data.content ?? existing.content;
      if (data.content !== undefined) {
        const [u] = await tx
          .select({
            chars: sql<number>`COALESCE(SUM(CHAR_LENGTH(${knowledgeDocs.content})), 0)`,
          })
          .from(knowledgeDocs)
          .where(eq(knowledgeDocs.agentId, existing.agent_id));
        const currentChars = Number(u?.chars ?? 0);
        const delta = [...newContent].length - [...existing.content].length;
        if (currentChars + delta > this.limits.maxTotalChars) {
          throw new KnowledgeLimitExceeded("修改后总字符数超出限制");
        }
        if ([...newContent].length > this.limits.maxDocChars) {
          throw new KnowledgeLimitExceeded("单篇文档字符数超出限制");
        }
      }
      await tx.execute(
        sql`UPDATE knowledge_docs
            SET revision = revision + 1,
                updated_at = NOW(3)
                ${data.title !== undefined ? sql`, title = ${data.title}` : sql``}
                ${data.content !== undefined ? sql`, content = ${data.content}` : sql``}
            WHERE id = ${id}`,
      );
      const afterRows = await tx
        .select()
        .from(knowledgeDocs)
        .where(eq(knowledgeDocs.id, id))
        .limit(1);
      const r = afterRows[0];
      if (!r) return null;
      return {
        id: r.id,
        agentId: r.agentId,
        title: r.title,
        content: r.content,
        createdAt: r.createdAt.getTime(),
      };
    });
  }

  /**
   * 文档集合指纹：数量 + 最新创建/修改时间 + 全部 id 的 CRC 异或。
   * 修改正文或标题后 updatedAt 变化，指纹随之变化，缓存失效。
   */
  async signatureOf(agentId: string): Promise<string> {
    const rows = await this.db
      .select({
        n: sql<number>`COUNT(*)`,
        rev: sql<number>`COALESCE(SUM(${knowledgeDocs.revision}), 0)`,
        ids: sql<number>`COALESCE(BIT_XOR(CRC32(${knowledgeDocs.id})), 0)`,
      })
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.agentId, agentId));
    const r = rows[0];
    return `${Number(r?.n ?? 0)}:${Number(r?.rev ?? 0)}:${Number(r?.ids ?? 0)}`;
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
      // 必须定序,且与 list() 完全一致:(创建时间, id) 升序取前 maxDocs 篇。
      // created_at 只到秒,同一秒的文档只按时间排序是不确定的,两边会在边界上各取各的
      .orderBy(asc(knowledgeDocs.createdAt), asc(knowledgeDocs.id))
      .limit(this.limits.maxDocs);

    const out: Chunk[] = [];
    for (const r of rows) {
      for (const [i, text] of chunkText(r.content).entries()) {
        out.push({ docId: r.id, docTitle: r.title, index: i, text });
      }
    }
    return out;
  }
}
