// 试算对账报表:取原始数据,按运行锁定的价目版本(含成本价)汇总。只读。
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import type { RunPricing } from "@/lib/shared";
import { type ReconLine, buildReconciliation } from "../domain/reconciliation";
import type { BillingMode } from "../domain/run-charge";
import type { RunChargeQuery } from "../run-charge-ports";

/** 一次最多汇总的天数与运行数 */
export const RECON_MAX_DAYS = 31;
export const RECON_MAX_RUNS = 50_000;

export async function reconciliationReport(
  deps: {
    query: Pick<RunChargeQuery, "reconciliationRows">;
    pricedModels: (pricing: RunPricing) => Promise<Capability[] | null>;
  },
  opts: { from: string; to: string; mode?: BillingMode },
): Promise<{ lines: ReconLine[]; truncated: boolean }> {
  const { rows, truncated } = await deps.query.reconciliationRows({
    ...opts,
    limit: RECON_MAX_RUNS,
  });
  const cache = new Map<string, Promise<Capability[] | null>>();
  const modelsOf = (p: RunPricing | null) => {
    if (!p) return Promise.resolve(null);
    const key = JSON.stringify(p.models);
    let hit = cache.get(key);
    if (!hit) {
      hit = deps.pricedModels(p).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
  const withModels = await Promise.all(
    rows.map(async ({ pricing, ...r }) => ({ ...r, models: await modelsOf(pricing) })),
  );
  return { lines: buildReconciliation(withModels), truncated };
}
