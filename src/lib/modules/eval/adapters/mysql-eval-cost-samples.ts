// 评测花费预估的样本(gaps A9):同一主模型引用、近 30 天已结算运行的实扣。
//
// 主模型引用取运行锁定的计价上下文 runs.cost → $.pricing.binding.mainRef(配置里写的别名或模型 id,
// 见 shared/types.ts 的 RunPricing),与草稿配置的 model 直接比较。
// 本智能体的样本排在前面,不足 20 条再用同模型的其它运行;设计器会话(平台的 AI 编辑)不算。

import type { Db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { EVAL_ESTIMATE_SAMPLES, EVAL_ESTIMATE_WINDOW_DAYS } from "../domain/cost-estimate";
import type { EvalCostSamples } from "../ports";

const DAY_MS = 86_400_000;

const rowsOf = <T>(r: unknown) => ((r as [T[]])[0] ?? []) as T[];

const charged = (r: unknown) =>
  rowsOf<{ charged_micro: string | number | null }>(r)
    .map((x) => (x.charged_micro === null ? "" : String(x.charged_micro)))
    .filter(Boolean);

/**
 * 【为什么分两步】先只看本智能体的运行(从 sessions.agent_id 出发,走 idx_sessions_agent),
 * 够 20 条就不碰全平台;不够才在 30 天窗口内(走 idx_runs_created)按同模型补齐。
 * 原先一条查询对 30 天内全平台的运行逐行 JSON_EXTRACT,而且每次打开评测阶段都会跑。
 */
export class MysqlEvalCostSamples implements EvalCostSamples {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async recentChargedMicro(agentId: string, model: string): Promise<string[]> {
    const sinceSec = Math.floor((this.now() - EVAL_ESTIMATE_WINDOW_DAYS * DAY_MS) / 1000);
    const own = charged(
      await this.db.execute(sql`
        SELECT CAST(c.charged_micro AS CHAR) AS charged_micro
        FROM sessions s
        JOIN runs r ON r.session_id = s.id
        JOIN run_charges c ON c.run_id = r.id
        WHERE s.agent_id = ${agentId}
          AND s.source <> 'design'
          AND r.created_at >= FROM_UNIXTIME(${sinceSec})
          AND c.state <> 'open'
          AND c.charged_micro IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(r.cost, '$.pricing.binding.mainRef')) = ${model}
        ORDER BY r.created_at DESC
        LIMIT ${EVAL_ESTIMATE_SAMPLES}`),
    );
    if (own.length >= EVAL_ESTIMATE_SAMPLES) return own;
    const rest = charged(
      await this.db.execute(sql`
        SELECT CAST(c.charged_micro AS CHAR) AS charged_micro
        FROM runs r
        JOIN sessions s ON s.id = r.session_id
        JOIN run_charges c ON c.run_id = r.id
        WHERE r.created_at >= FROM_UNIXTIME(${sinceSec})
          AND s.agent_id <> ${agentId}
          AND s.source <> 'design'
          AND c.state <> 'open'
          AND c.charged_micro IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(r.cost, '$.pricing.binding.mainRef')) = ${model}
        ORDER BY r.created_at DESC
        LIMIT ${EVAL_ESTIMATE_SAMPLES - own.length}`),
    );
    return [...own, ...rest];
  }
}
