import type { RunPricing } from "@/lib/shared";
import type { Capability } from "../domain/catalog";
import type { CapabilityRepo } from "../ports";

/**
 * 一次运行当时的价目:按运行记录的提供者与模型版本取快照。
 *
 * 只包含本次运行所属提供者的模型,同一模型标识出现在多个提供者下也不会互相干扰。
 * 版本只追加不修改,所以可以放心缓存。
 */
export class PricedModels {
  private readonly cache = new Map<string, Capability>();

  constructor(private readonly repo: CapabilityRepo) {}

  /** 没有计价上下文(旧运行)返回 null,由调用方回落到当前价目。 */
  async forRun(pricing: RunPricing | undefined): Promise<Capability[] | null> {
    if (!pricing?.models?.length) return null;
    const out: Capability[] = [];
    for (const m of pricing.models) {
      const key = `${m.capabilityId}:${m.version}`;
      let snapshot = this.cache.get(key);
      if (!snapshot) {
        const v = await this.repo.version(m.capabilityId, m.version);
        if (!v) continue;
        const { createdBy: _, ...cap } = v;
        snapshot = cap;
        this.cache.set(key, snapshot);
      }
      out.push(snapshot);
    }
    return out;
  }
}
