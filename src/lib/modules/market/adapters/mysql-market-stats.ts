// 市场卡片上的作者、近 90 天使用次数、近 90 天里最近 50 次成功运行的平均实扣(gaps.md A10 / A11)。
//
// 【为什么是一条聚合查询】市场一页几十张卡片,逐张查就是 N+1,列表会随上架数线性变慢。
// 这里一条 SQL 把所有卡片的两个数字一起算出来(窗口函数给每个智能体的成功运行排名,取前 50),
// 作者另用一条按 id 批量查用户。结果在进程内缓存 60 秒:这两个数字不需要实时。
// 子查询按 runs.created_at 截在 90 天窗口内(走 idx_runs_created):这张表只增不减,
// 不截断的话每次都要给上架智能体的全部历史运行排序,扫描量随时间无上限地增长。

import type { Db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import {
  MARKET_AVG_SAMPLE,
  MARKET_USE_WINDOW_DAYS,
  type MarketStats,
  type MarketStatsSource,
  authorOf,
  avgCreditsOf,
} from "../domain/stats";

const TTL_MS = 60_000;
const DAY_MS = 86_400_000;
/** 计入使用次数的会话来源:评测与设计器会话不算「有人在用」 */
const USE_SOURCES = ["web", "api", "invoke"];

const rowsOf = <T>(r: unknown) => ((r as [T[]])[0] ?? []) as T[];
const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

export class MysqlMarketStats implements MarketStatsSource {
  private readonly cache = new Map<string, { at: number; value: MarketStats }>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async forAgents(
    agents: readonly { id: string; ownerId: string }[],
  ): Promise<Map<string, MarketStats>> {
    const out = new Map<string, MarketStats>();
    if (agents.length === 0) return out;
    const now = this.now();
    const missing = agents.filter((a) => {
      const hit = this.cache.get(a.id);
      if (hit && now - hit.at < TTL_MS) {
        out.set(a.id, hit.value);
        return false;
      }
      return true;
    });
    if (missing.length === 0) return out;

    const agentIds = [...new Set(missing.map((a) => a.id))];
    const ownerIds = [...new Set(missing.map((a) => a.ownerId))];
    const since = now - MARKET_USE_WINDOW_DAYS * DAY_MS;

    const [usage, owners] = await Promise.all([
      this.db.execute(sql`
        SELECT agent_id,
               COUNT(*) AS use_count,
               AVG(CASE WHEN ok_rank <= ${MARKET_AVG_SAMPLE} THEN charged_micro END) AS avg_micro
        FROM (
          SELECT s.agent_id,
                 c.charged_micro,
                 CASE WHEN r.status = 'success' AND c.charged_micro IS NOT NULL AND c.state <> 'open'
                      THEN ROW_NUMBER() OVER (
                        PARTITION BY s.agent_id,
                          (r.status = 'success' AND c.charged_micro IS NOT NULL AND c.state <> 'open')
                        ORDER BY r.created_at DESC, r.id DESC)
                 END AS ok_rank
          FROM runs r
          JOIN sessions s ON s.id = r.session_id
          LEFT JOIN run_charges c ON c.run_id = r.id
          WHERE r.created_at >= FROM_UNIXTIME(${Math.floor(since / 1000)})
            AND s.agent_id IN (${list(agentIds)})
            AND s.source IN (${list(USE_SOURCES)})
        ) t
        GROUP BY agent_id`),
      this.db.execute(sql`SELECT id, email FROM users WHERE id IN (${list(ownerIds)})`),
    ]);

    const byAgent = new Map(
      rowsOf<{ agent_id: string; use_count: string | number | null; avg_micro: string | null }>(
        usage,
      ).map((r) => [r.agent_id, r]),
    );
    const emails = new Map(
      rowsOf<{ id: string; email: string }>(owners).map((r) => [r.id, r.email]),
    );
    for (const agent of missing) {
      const row = byAgent.get(agent.id);
      const value: MarketStats = {
        author: authorOf(emails.get(agent.ownerId)),
        useCount: Number(row?.use_count ?? 0) || 0,
        avgCredits: avgCreditsOf(row?.avg_micro),
      };
      this.cache.set(agent.id, { at: now, value });
      out.set(agent.id, value);
    }
    return out;
  }
}
