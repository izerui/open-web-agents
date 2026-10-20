// 结算计价:按运行受理时锁定的价目版本(售价)把用量折成积分。
//
// 认得出的模型按它自己的售价;认不出模型或缺价目的那部分,按本次运行锁定的【主模型】售价计 ——
// 每次运行结束都要能结清,不留需要人工处理的记录。连按模型的明细都没有的,用总 token 数按主模型计。
// 用到兜底的 token 数单独返回,对账报表据此列出,便于复盘配置(多半是上游回报的模型名与填写的标识不一致)。

import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import { type Capability, type Meter, priceUsage } from "@/lib/modules/capabilities/domain/catalog";

export interface SettlePrice {
  /** 能否计价(取不到主模型的价目时不能) */
  priceable: boolean;
  /** 积分(微积分,按售价) */
  micro: bigint;
  /** 按主模型价兜底的 token 数 */
  fallbackTokens: number;
}

interface CostLike {
  input?: number;
  output?: number;
  metering?: ModelMetering;
}

function usageOf(u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Partial<Record<Meter, string>> {
  const usage: Partial<Record<Meter, string>> = {};
  if (u.inputTokens > 0) usage.input_token = String(u.inputTokens);
  if (u.outputTokens > 0) usage.output_token = String(u.outputTokens);
  if (u.cacheReadTokens > 0) usage.cache_read_token = String(u.cacheReadTokens);
  if (u.cacheWriteTokens > 0) usage.cache_write_token = String(u.cacheWriteTokens);
  return usage;
}

function tryPrice(
  cap: Capability | undefined,
  usage: Partial<Record<Meter, string>>,
): bigint | null {
  if (!cap) return null;
  try {
    return BigInt(priceUsage(cap.rates, usage).microCredits);
  } catch {
    return null;
  }
}

export function priceForSettlement(
  cost: unknown,
  models: Capability[] | null,
  mainCapabilityId: string | null | undefined,
): SettlePrice {
  const c = (cost ?? {}) as CostLike;
  const llm = (models ?? []).filter((m) => m.kind === "llm");
  const main = llm.find((m) => m.id === mainCapabilityId);
  const byModel = new Map<string, Capability | "ambiguous">();
  for (const m of llm) byModel.set(m.modelId, byModel.has(m.modelId) ? "ambiguous" : m);

  const usages = c.metering?.models ?? [];
  if (usages.length === 0) {
    // 没有按模型的明细:用总 token 数按主模型计
    const tokens = {
      inputTokens: c.input ?? 0,
      outputTokens: c.output ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const total = tokens.inputTokens + tokens.outputTokens;
    if (total === 0) return { priceable: true, micro: 0n, fallbackTokens: 0 };
    const micro = tryPrice(main, usageOf(tokens));
    return micro === null
      ? { priceable: false, micro: 0n, fallbackTokens: 0 }
      : { priceable: true, micro, fallbackTokens: total };
  }

  let micro = 0n;
  let fallbackTokens = 0;
  for (const u of usages) {
    const usage = usageOf(u);
    const own = byModel.get(u.modelId);
    const priced = tryPrice(own && own !== "ambiguous" ? own : undefined, usage);
    if (priced !== null) {
      micro += priced;
      continue;
    }
    const fallback = tryPrice(main, usage);
    if (fallback === null) return { priceable: false, micro: 0n, fallbackTokens: 0 };
    micro += fallback;
    fallbackTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  }
  return { priceable: true, micro, fallbackTokens };
}
