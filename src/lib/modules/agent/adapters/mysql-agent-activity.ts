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
 * 两条查询取齐整页 —— 逐个智能体数一次就是 N+1,列表一长首屏就慢。
 *
 * 【为什么拆成两条】运行数从 runs 出发、先按 created_at 截在窗口内(走 idx_runs_created),
 * 再 JOIN sessions 按智能体分组;更新时间直接按 id 读 agents。原先从 agents 出发 LEFT JOIN
 * 全部 sessions,会把每个智能体的全部历史会话都过一遍 —— 每次接口调用都会新建会话,
 * 而 GET /api/agents 在构建页每次自动保存后都会刷新,这个扫描量随时间无上限地增长。
 */
export class MysqlAgentActivity implements AgentActivityQuery {
  constructor(private readonly db: Db) {}

  async of(agentIds: string[], sinceMs: number): Promise<Map<string, AgentActivity>> {
    const out = new Map<string, AgentActivity>();
    if (!agentIds.length) return out;
    const [counts, updated] = await Promise.all([
      this.db
        .select({ id: sessions.agentId, runs: count(runs.id) })
        .from(runs)
        .innerJoin(sessions, eq(sessions.id, runs.sessionId))
        .where(and(gte(runs.createdAt, new Date(sinceMs)), inArray(sessions.agentId, agentIds)))
        .groupBy(sessions.agentId),
      this.db
        .select({ id: agents.id, updatedAt: agents.updatedAt })
        .from(agents)
        .where(inArray(agents.id, agentIds)),
    ]);
    const runsOf = new Map(counts.map((r) => [r.id, Number(r.runs)]));
    for (const r of updated) {
      out.set(r.id, { runs: runsOf.get(r.id) ?? 0, updatedAt: new Date(r.updatedAt).getTime() });
    }
    return out;
  }
}
