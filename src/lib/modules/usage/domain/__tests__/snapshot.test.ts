import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import type { CapabilityDefinition } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import { type RunCreditEstimate, estimateRunCredits } from "../estimate";

const cap = (modelId: string, inputPrice = "10", outputPrice = "20"): CapabilityDefinition => ({
  id: `cap-${modelId}`,
  name: modelId,
  kind: "llm",
  modelId,
  enabled: true,
  acceptsImages: false,
  rates: [
    { meter: "input_token", units: "1000", microCredits: inputPrice },
    { meter: "output_token", units: "1000", microCredits: outputPrice },
    { meter: "cache_read_token", units: "1000", microCredits: "0" },
    { meter: "cache_write_token", units: "1000", microCredits: inputPrice },
  ],
});

const metering: ModelMetering = {
  source: "sdk_model_usage",
  complete: true,
  models: [
    {
      modelId: "claude-sonnet-4-20250514",
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ],
};

describe("run-level price snapshot", () => {
  it("stored creditEstimate is not affected by price changes", () => {
    const priceA = [cap("claude-sonnet-4-20250514", "10", "20")];
    const snapshotAtPriceA = estimateRunCredits(metering, priceA);
    // price A: 5000*10/1000 + 1000*20/1000 = 50+20 = 70
    expect(snapshotAtPriceA.totalMicroCredits).toBe("70");

    const priceB = [cap("claude-sonnet-4-20250514", "100", "200")];
    const realtimeAtPriceB = estimateRunCredits(metering, priceB);
    // price B: 5000*100/1000 + 1000*200/1000 = 500+200 = 700
    expect(realtimeAtPriceB.totalMicroCredits).toBe("700");

    // Simulating the API behavior: stored estimate takes precedence
    const storedEstimate: RunCreditEstimate = snapshotAtPriceA;
    const apiResult = storedEstimate ?? estimateRunCredits(metering, priceB);
    expect(apiResult.totalMicroCredits).toBe("70");
  });

  it("old runs without creditEstimate fall back to current price", () => {
    const storedEstimate: RunCreditEstimate | undefined = undefined;
    const priceB = [cap("claude-sonnet-4-20250514", "100", "200")];
    const apiResult = storedEstimate ?? estimateRunCredits(metering, priceB);
    expect(apiResult.totalMicroCredits).toBe("700");
  });

  it("sub-models not in price catalog remain unpriced regardless of future catalog additions", () => {
    const priceA = [cap("claude-sonnet-4-20250514", "10", "20")];
    const mixedMetering: ModelMetering = {
      source: "sdk_model_usage",
      complete: true,
      models: [
        {
          modelId: "claude-sonnet-4-20250514",
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          modelId: "claude-haiku-3-5-20241022",
          inputTokens: 3000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    };
    const snapshot = estimateRunCredits(mixedMetering, priceA);
    expect(snapshot.totalMicroCredits).toBe("70");
    expect(snapshot.models[1]).toMatchObject({
      modelId: "claude-haiku-3-5-20241022",
      unpriced: true,
      microCredits: null,
    });

    // Even if haiku is added to catalog later, the stored snapshot keeps it unpriced
    const priceWithHaiku = [...priceA, cap("claude-haiku-3-5-20241022", "2", "6")];
    const realtimeWithHaiku = estimateRunCredits(mixedMetering, priceWithHaiku);
    expect(realtimeWithHaiku.totalMicroCredits).toBe("79");

    const apiResult = snapshot ?? realtimeWithHaiku;
    expect(apiResult.totalMicroCredits).toBe("70");
    expect(apiResult.models[1]?.unpriced).toBe(true);
  });

  it("enrichCost pattern adds creditEstimate to cost object", async () => {
    const priceA = [cap("claude-sonnet-4-20250514", "10", "20")];
    const enrichCost = async (raw: unknown) => {
      const cost = raw as Record<string, unknown> | null;
      if (!cost?.metering) return raw;
      return {
        ...cost,
        creditEstimate: estimateRunCredits(cost.metering as ModelMetering, priceA),
      };
    };

    const originalCost = { usd: 0.01, input: 5000, output: 1000, metering };
    const enriched = (await enrichCost(originalCost)) as Record<string, unknown>;
    expect(enriched.creditEstimate).toBeDefined();
    expect((enriched.creditEstimate as RunCreditEstimate).totalMicroCredits).toBe("70");
    expect(enriched.usd).toBe(0.01);
    expect(enriched.metering).toBe(metering);
  });

  it("enrichCost passes through cost without metering unchanged", async () => {
    const enrichCost = async (raw: unknown) => {
      const cost = raw as Record<string, unknown> | null;
      if (!cost?.metering) return raw;
      return { ...cost, creditEstimate: estimateRunCredits(cost.metering as ModelMetering, []) };
    };
    const noMetering = { usd: 0.01, input: 100, output: 50 };
    expect(await enrichCost(noMetering)).toBe(noMetering);
  });
});
