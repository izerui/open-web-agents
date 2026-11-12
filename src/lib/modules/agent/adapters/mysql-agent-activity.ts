import type { Db } from "@/lib/db/client";
import { agents, runs, sessions } from "@/lib/db/schema";
import { and, count, eq, gte, inArray } from "drizzle-orm";

export interface AgentActivity {
  /** 窗口内的运行数(所有入口:对话、接口、评测……) */
  runs: number;
  /** 草稿最后修改时间(ms) */
  updatedAt: number;
}

/** 工作室列表的活跃度:近 N 天运行数与更新时间。 */
export interface AgentActivityQuery {
  of(agentIds: string[], sinceMs: number): Promise<Map<string, AgentActivity>>;
}

/**
 * 一条聚合查询取齐整页 —— 逐个智能体数一次就是 N+1,列表一长首屏就慢。
 * 时间条件放在 runs 的 JOIN 上而不是 WHERE:没有运行的智能体也要回来(计 0),
 * 否则拿不到它的更新时间。
 */
export class MysqlAgentActivity implements AgentActivityQuery {
  constructor(private readonly db: Db) {}

  async of(agentIds: string[], sinceMs: number): Promise<Map<string, AgentActivity>> {
    const out = new Map<string, AgentActivity>();
    if (!agentIds.length) return out;
    const rows = await this.db
      .select({ id: agents.id, updatedAt: agents.updatedAt, runs: count(runs.id) })
      .from(agents)
      .leftJoin(sessions, eq(sessions.agentId, agents.id))
      .leftJoin(runs, and(eq(runs.sessionId, sessions.id), gte(runs.createdAt, new Date(sinceMs))))
      .where(inArray(agents.id, agentIds))
      .groupBy(agents.id, agents.updatedAt);
    for (const r of rows) {
      out.set(r.id, { runs: Number(r.runs), updatedAt: new Date(r.updatedAt).getTime() });
    }
    return out;
  }
}
