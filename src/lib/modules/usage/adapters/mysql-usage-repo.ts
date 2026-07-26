import type { Db } from "@/lib/db/client";
import { assistants, runs, sessions } from "@/lib/db/schema";
import { type RunUsageRecord, toMicroUsd } from "@/lib/modules/usage/domain/aggregate";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export interface UsageQuery {
  /** 只统计该用户归属的会话;不传则统计全部(仅 admin 可用)。 */
  ownerId?: string;
  /** 起始时间(ms)。 */
  since: number;
  limit?: number;
}

export class MysqlUsageRepo {
  constructor(private readonly db: Db) {}

  /**
   * 拉取窗口内的运行记录,聚合交给纯域函数。
   *
   * 有意不在 SQL 里做聚合:分组口径(按天/按助手/UTC 边界)属于业务规则,
   * 放在可单测的域层比藏在 SQL 里更容易验证与演进。窗口有上限,不会拉爆内存。
   */
  async list(q: UsageQuery): Promise<RunUsageRecord[]> {
    const conds = [gte(runs.createdAt, new Date(q.since))];
    if (q.ownerId) conds.push(eq(sessions.ownerId, q.ownerId));

    const rows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        cost: runs.cost,
        assistantId: sessions.assistantId,
        assistantName: assistants.name,
        ownerId: sessions.ownerId,
        endedAt: runs.endedAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .leftJoin(assistants, eq(sessions.assistantId, assistants.id))
      .where(and(...conds))
      .orderBy(desc(runs.createdAt))
      .limit(q.limit ?? 5000);

    return rows.map((r) => {
      const cost = (r.cost ?? {}) as { usd?: number; input?: number; output?: number };
      return {
        runId: r.runId,
        assistantId: r.assistantId,
        assistantName: r.assistantName ?? undefined,
        ownerId: r.ownerId ?? undefined,
        status: r.status,
        costMicroUsd: toMicroUsd(cost.usd),
        inputTokens: Number(cost.input ?? 0),
        outputTokens: Number(cost.output ?? 0),
        // 未结束的用创建时间,保证一定落在某一天里
        at: (r.endedAt ?? r.createdAt).getTime(),
      };
    });
  }

  /** 当前排队/在跑的任务数,看板用来判断系统是否积压。 */
  async queueDepth(): Promise<{ pending: number; running: number }> {
    const rows = await this.db
      .select({ status: runs.status, n: sql<number>`COUNT(*)` })
      .from(runs)
      .groupBy(runs.status);
    let pending = 0;
    let running = 0;
    for (const r of rows) {
      if (r.status === "pending") pending = Number(r.n);
      if (r.status === "running") running = Number(r.n);
    }
    return { pending, running };
  }
}
