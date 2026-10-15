import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import type { CapabilityDefinition, Meter } from "@/lib/modules/capabilities/domain/catalog";
import { priceUsage } from "@/lib/modules/capabilities/domain/catalog";

export interface ModelCreditEstimate {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  microCredits: string | null;
  unpriced: boolean;
}

export interface RunCreditEstimate {
  totalMicroCredits: string;
  complete: boolean;
  source: "sdk_model_usage";
  models: ModelCreditEstimate[];
}

const EMPTY: RunCreditEstimate = {
  totalMicroCredits: "0",
  complete: false,
  source: "sdk_model_usage",
  models: [],
};

export function estimateRunCredits(
  metering: ModelMetering | undefined,
  capabilities: CapabilityDefinition[],
): RunCreditEstimate {
  if (!metering || metering.models.length === 0) return EMPTY;

  const capByModel = new Map<string, CapabilityDefinition | "ambiguous">();
  for (const c of capabilities) {
    if (!c.enabled || c.kind !== "llm") continue;
    if (capByModel.has(c.modelId)) {
      capByModel.set(c.modelId, "ambiguous");
    } else {
      capByModel.set(c.modelId, c);
    }
  }
  const models: ModelCreditEstimate[] = [];
  let total = 0n;

  for (const m of metering.models) {
    const entry = capByModel.get(m.modelId);
    const cap = entry && entry !== "ambiguous" ? entry : undefined;
    let microCredits: string | null = null;
    if (cap) {
      const usage: Partial<Record<Meter, string>> = {};
      if (m.inputTokens > 0) usage.input_token = String(m.inputTokens);
      if (m.outputTokens > 0) usage.output_token = String(m.outputTokens);
      if (m.cacheReadTokens > 0) usage.cache_read_token = String(m.cacheReadTokens);
      if (m.cacheWriteTokens > 0) usage.cache_write_token = String(m.cacheWriteTokens);
      try {
        const result = priceUsage(cap.rates, usage);
        microCredits = result.microCredits;
        total += BigInt(result.microCredits);
      } catch {
        microCredits = null;
      }
    }
    models.push({
      modelId: m.modelId,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      microCredits,
      unpriced: microCredits === null,
    });
  }

  return {
    totalMicroCredits: total.toString(),
    complete: metering.complete,
    source: "sdk_model_usage",
    models,
  };
}
