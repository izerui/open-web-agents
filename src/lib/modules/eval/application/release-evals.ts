// 评测与发布的关联:某一版(或草稿)的评测结论,以及发布门槛(见 domain/release-gate.ts)。

import type { PublishGate } from "@/lib/modules/agent/application/releases";
import { type EvalVerdict, casesHash, publishBlockReason, verdictOf } from "../domain/release-gate";
import type { EvalRepo, EvalRun } from "../ports";

export class ReleaseEvals implements PublishGate {
  constructor(
    private readonly evals: Pick<EvalRepo, "listCases" | "latestByConfig">,
    /**
     * 判分是读评测时顺带做的(见 readEvalRun):用例的运行都结束了、但没人打开过这次评测,
     * 库里仍是"进行中"。遇到进行中的先结算一次,返回结算后的评测
     */
    private readonly settle?: (evalRunId: string) => Promise<EvalRun | null>,
  ) {}

  /** 各内容摘要的评测结论(当前用例只读一次) */
  async verdicts(agentId: string, configHashes: string[]): Promise<Map<string, EvalVerdict>> {
    const [cases, latest] = await Promise.all([
      this.evals.listCases(agentId),
      this.evals.latestByConfig(agentId, configHashes),
    ]);
    if (this.settle) {
      for (const [hash, run] of latest) {
        if (run.status !== "running") continue;
        const settled = await this.settle(run.id);
        if (settled) latest.set(hash, settled);
      }
    }
    const current = casesHash(cases);
    return new Map(configHashes.map((h) => [h, verdictOf(latest.get(h), current)]));
  }

  async blockReason(agentId: string, contentHash: string): Promise<string | null> {
    const v = (await this.verdicts(agentId, [contentHash])).get(contentHash);
    return v ? publishBlockReason(v) : "无法确认评测结果";
  }
}
