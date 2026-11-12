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

export class MysqlEvalCostSamples implements EvalCostSamples {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async recentChargedMicro(agentId: string, model: string): Promise<string[]> {
    const sinceSec = Math.floor((this.now() - EVAL_ESTIMATE_WINDOW_DAYS * DAY_MS) / 1000);
    const result = await this.db.execute(sql`
      SELECT CAST(c.charged_micro AS CHAR) AS charged_micro
      FROM runs r
      JOIN sessions s ON s.id = r.session_id
      JOIN run_charges c ON c.run_id = r.id
      WHERE c.state <> 'open'
        AND c.charged_micro IS NOT NULL
        AND s.source <> 'design'
        AND r.created_at >= FROM_UNIXTIME(${sinceSec})
        AND JSON_UNQUOTE(JSON_EXTRACT(r.cost, '$.pricing.binding.mainRef')) = ${model}
      ORDER BY (s.agent_id = ${agentId}) DESC, r.created_at DESC
      LIMIT ${EVAL_ESTIMATE_SAMPLES}`);
    return rowsOf<{ charged_micro: string | number | null }>(result)
      .map((r) => (r.charged_micro === null ? "" : String(r.charged_micro)))
      .filter(Boolean);
  }
}
