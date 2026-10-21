import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { knowledgeDocs } from "@/lib/db/schema";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeLimitExceeded,
  type KnowledgeLimits,
  KnowledgeWriteAborted,
  batchLimitViolation,
} from "@/lib/modules/knowledge/domain/limits";
import { type Chunk, chunkText } from "@/lib/modules/knowledge/domain/retrieval";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type mysql from "mysql2/promise";
import mysqlPromise from "mysql2/promise";

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
    /**
     * 底层连接池。给了它,带期限的 createMany 自己从池里拿连接、拿连接有界,整个写入(含回读)
     * 在这一个连接上完成;不给(如嵌在别的事务里用)则走 db 本身
     */
    private readonly pool?: mysql.Pool,
  ) {}

  /**
   * 从池里拿一个连接,最多等到 deadline。等不到抛 KnowledgeWriteAborted("timeout");
   * 那之后池子才分到的连接拿到就立刻还回去,不占着。等待期间调用方取消同样放弃
   */
  private acquire(pool: mysql.Pool, deadline: number, signal?: AbortSignal) {
    return new Promise<mysql.PoolConnection>((resolve, reject) => {
      let gaveUp = false;
      const giveUp = (why: "timeout" | "aborted") => {
        if (gaveUp) return;
        gaveUp = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new KnowledgeWriteAborted(why));
      };
      const onAbort = () => giveUp("aborted");
      const timer = setTimeout(() => giveUp("timeout"), Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      pool.getConnection().then(
        (conn) => {
          if (gaveUp) {
            conn.release();
            return;
          }
          gaveUp = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(conn);
        },
        (err) => {
          if (gaveUp) return;
          gaveUp = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * 新增一篇。超限抛 KnowledgeLimitExceeded。
   * 计数与插入在同一事务里、先锁住智能体那一行:并发上传不能各自看到"还差一篇"而一起越过上限。
   */
  async create(d: NewKnowledgeDoc): Promise<KnowledgeDoc> {
    const [got] = await this.createMany(d.agentId, [d]);
    if (!got) throw new Error(`knowledge doc insert failed: ${d.id}`);
    return got;
  }

  /**
   * 一次新增多篇(上传的长文件切成的几篇):全部进库或全部不进,上限按这几篇合计判定。
   * 计数与插入在同一事务里、先锁住智能体那一行 —— 并发上传不能各自看到"还差一篇"而一起越过上限。
   *
   * opts.deadline / opts.signal:调用方的期限与取消(上传请求)。【不能只在外面计时】等行锁期间
   * 调用方超时或断开,锁一释放这里照样会插入并提交 —— 用户看到失败,文档却进了库。所以:
   * 本事务的等锁时间不超过剩余时间(到点 MySQL 报等锁超时、回滚);拿到锁后、插入后提交前各复查一次,
   * 已取消或已超时就抛 KnowledgeWriteAborted,事务回滚,一篇都不写
   */
  async createMany(
    agentId: string,
    docs: NewKnowledgeDoc[],
    opts: { deadline?: number; signal?: AbortSignal } = {},
  ): Promise<KnowledgeDoc[]> {
    if (docs.some((d) => d.agentId !== agentId)) throw new Error("docs 必须属于同一个智能体");
    if (docs.length === 0) return [];
    const check = () => {
      if (opts.signal?.aborted) throw new KnowledgeWriteAborted("aborted");
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        throw new KnowledgeWriteAborted("timeout");
      }
    };
    check();
    // 有期限且有连接池:拿连接有界,整个写入(含回读)在这一个连接上完成,提交后不再排队拿连接
    const conn =
      opts.deadline !== undefined && this.pool
        ? await this.acquire(this.pool, opts.deadline, opts.signal)
        : null;
    const db = conn ? (drizzle(conn, { schema, mode: "default" }) as unknown as Db) : this.db;
    let saved: KnowledgeDoc[] = [];
    // 【独占连接上主动终止】只靠事务里的两次 check() 是被动的:正在等锁(或执行任何一条查询)时断开或到点,
    // 查询会一直等下去,连接与上传名额都被占着。所以取消或到期时直接销毁这个连接,并在服务端 KILL 掉它的会话
    // —— 未提交的事务随之回滚,不可能再提交。等锁、计数、插入、回读、恢复会话设置都在同一个期限里
    let terminated: "timeout" | "aborted" | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // mysql2 的 destroy() 之后,正在执行的查询的回调再也不会被调用(实测会一直挂着):
    // 终止时由这里给出结论。连接已销毁、服务端会话已 KILL,事务不可能再继续或提交
    let stopped: (err: Error) => void = () => {};
    const stoppedPromise = new Promise<never>((_, reject) => {
      stopped = reject;
    });
    stoppedPromise.catch(() => {});
    const terminate = (why: "timeout" | "aborted") => {
      if (!conn || terminated) return;
      terminated = why;
      stopped(new KnowledgeWriteAborted(why));
      const threadId = (conn as unknown as { connection?: { threadId?: number } }).connection
        ?.threadId;
      try {
        conn.destroy();
      } catch {
        // 已经断了
      }
      if (threadId) void this.killSession(threadId);
    };
    const onAbort = () => terminate("aborted");
    if (conn && opts.deadline !== undefined) {
      killTimer = setTimeout(() => terminate("timeout"), Math.max(0, opts.deadline - Date.now()));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    }
    try {
      const writing = db.transaction(async (tx) => {
        let restoreLockWait: number | null = null;
        try {
          if (opts.deadline !== undefined) {
            // innodb_lock_wait_timeout 只能按整秒设,向上取整:多出的不到一秒由下面拿到锁后的复查兜住
            const seconds = Math.max(1, Math.ceil((opts.deadline - Date.now()) / 1000));
            const prev = await tx.execute(sql`SELECT @@SESSION.innodb_lock_wait_timeout AS v`);
            restoreLockWait = Number(((prev as unknown as [{ v: number }[]])[0] ?? [])[0]?.v ?? 50);
            await tx.execute(sql.raw(`SET SESSION innodb_lock_wait_timeout = ${seconds}`));
          }
          let locked: unknown;
          try {
            locked = await tx.execute(
              sql`SELECT id FROM agents WHERE id = ${agentId} LIMIT 1 FOR UPDATE`,
            );
          } catch (err) {
            // 1205 = ER_LOCK_WAIT_TIMEOUT:等锁到了期限
            if ((err as { errno?: number }).errno === 1205)
              throw new KnowledgeWriteAborted("timeout");
            throw err;
          }
          const lockedRows = (locked as unknown as [unknown[]])[0];
          if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
            throw new Error(`agent not found: ${agentId}`);
          }
          // 等锁期间可能已经断开或到点
          check();
          const [u] = await tx
            .select({
              docs: sql<number>`COUNT(*)`,
              chars: sql<number>`COALESCE(SUM(CHAR_LENGTH(${knowledgeDocs.content})), 0)`,
            })
            .from(knowledgeDocs)
            .where(eq(knowledgeDocs.agentId, agentId));
          const reason = batchLimitViolation(
            { docs: Number(u?.docs ?? 0), chars: Number(u?.chars ?? 0) },
            docs.map((d) => [...d.content].length),
            this.limits,
          );
          if (reason) throw new KnowledgeLimitExceeded(reason);
          await tx.insert(knowledgeDocs).values(docs);
          // 回读在事务内、同一个连接上做:提交后再去池里排队拿连接,又是一段不限时的等待
          const rows = await tx
            .select()
            .from(knowledgeDocs)
            .where(
              inArray(
                knowledgeDocs.id,
                docs.map((d) => d.id),
              ),
            );
          const byId = new Map(rows.map((r) => [r.id, r]));
          saved = docs.map((d) => {
            const r = byId.get(d.id);
            if (!r) throw new Error(`knowledge doc insert failed: ${d.id}`);
            return {
              id: r.id,
              agentId: r.agentId,
              title: r.title,
              content: r.content,
              createdAt: r.createdAt.getTime(),
            };
          });
          // 提交前最后一次:此刻放弃,事务回滚
          check();
        } finally {
          if (restoreLockWait !== null) {
            await tx
              .execute(sql.raw(`SET SESSION innodb_lock_wait_timeout = ${restoreLockWait}`))
              .catch(() => {});
          }
        }
      });
      writing.catch(() => {});
      await (conn ? Promise.race([writing, stoppedPromise]) : writing);
    } catch (err) {
      // 连接是我们终止的:按终止原因报,不报底层的"连接已断开"
      if (terminated) throw new KnowledgeWriteAborted(terminated);
      throw err;
    } finally {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (conn && !terminated) conn.release();
    }
    return saved;
  }

  /**
   * 在服务端结束一个会话(另开一条临时连接执行 KILL,不占连接池)。只销毁本地连接时,服务端那条
   * 会话可能还在等锁,直到等锁超时才发现客户端没了。尽力而为、有界:失败不影响结果(事务未提交,
   * 连接已断,本来就提交不了)
   */
  private async killSession(threadId: number): Promise<void> {
    const config = (this.pool as unknown as { pool?: { config?: { connectionConfig?: object } } })
      ?.pool?.config?.connectionConfig;
    if (!config) return;
    let killer: mysql.Connection | undefined;
    const timer = setTimeout(() => killer?.destroy(), 5_000);
    try {
      killer = await mysqlPromise.createConnection({ ...config, connectTimeout: 3_000 });
      await killer.query("KILL ?", [threadId]);
    } catch {
      // 会话可能已经自己结束了
    } finally {
      clearTimeout(timer);
      await killer?.end().catch(() => killer?.destroy());
    }
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
