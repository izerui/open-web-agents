import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import type { CapabilityDefinition } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import { estimateRunCredits } from "../estimate";

const cap = (modelId: string, inputPrice = "1", outputPrice = "2"): CapabilityDefinition => ({
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

const model = (modelId: string, input = 5000, output = 1000) => ({
  modelId,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const metering = (models: ReturnType<typeof model>[], complete = true): ModelMetering => ({
  source: "sdk_model_usage",
  complete,
  models,
});

describe("estimateRunCredits", () => {
  it("returns zero estimate when metering is undefined", () => {
    const result = estimateRunCredits(undefined, [cap("claude-sonnet-4-20250514")]);
    expect(result.totalMicroCredits).toBe("0");
    expect(result.complete).toBe(false);
    expect(result.models).toEqual([]);
  });

  it("returns zero estimate when metering has no models", () => {
    const result = estimateRunCredits(metering([]), [cap("claude-sonnet-4-20250514")]);
    expect(result.totalMicroCredits).toBe("0");
    expect(result.models).toEqual([]);
  });

  it("computes credits from token counts and catalog rates with ceiling division", () => {
    const result = estimateRunCredits(metering([model("claude-sonnet-4-20250514", 5000, 1000)]), [
      cap("claude-sonnet-4-20250514", "10", "20"),
    ]);
    expect(result.complete).toBe(true);
    expect(result.source).toBe("sdk_model_usage");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      modelId: "claude-sonnet-4-20250514",
      inputTokens: 5000,
      outputTokens: 1000,
      unpriced: false,
    });
    // 5000 input * 10/1000 = 50, 1000 output * 20/1000 = 20 → total 70
    expect(result.totalMicroCredits).toBe("70");
    expect(result.models[0]?.microCredits).toBe("70");
  });

  it("marks models without catalog entry as unpriced and excludes from total", () => {
    const result = estimateRunCredits(
      metering([model("claude-sonnet-4-20250514", 5000, 1000), model("unknown-model", 3000, 500)]),
      [cap("claude-sonnet-4-20250514", "10", "20")],
    );
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      modelId: "claude-sonnet-4-20250514",
      unpriced: false,
    });
    expect(result.models[1]).toMatchObject({
      modelId: "unknown-model",
      unpriced: true,
      microCredits: null,
    });
    expect(result.totalMicroCredits).toBe("70");
  });

  it("excludes disabled capabilities from pricing", () => {
    const disabled = { ...cap("claude-sonnet-4-20250514"), enabled: false };
    const result = estimateRunCredits(metering([model("claude-sonnet-4-20250514", 5000, 1000)]), [
      disabled,
    ]);
    expect(result.models[0]?.unpriced).toBe(true);
    expect(result.totalMicroCredits).toBe("0");
  });

  it("propagates complete=false from metering", () => {
    const result = estimateRunCredits(metering([model("claude-sonnet-4-20250514")], false), [
      cap("claude-sonnet-4-20250514"),
    ]);
    expect(result.complete).toBe(false);
  });

  it("handles multiple models including sub-agent usage", () => {
    const result = estimateRunCredits(
      metering([
        model("claude-sonnet-4-20250514", 10000, 2000),
        model("claude-haiku-3-5-20241022", 8000, 1500),
      ]),
      [cap("claude-sonnet-4-20250514", "10", "30"), cap("claude-haiku-3-5-20241022", "2", "6")],
    );
    // sonnet: 10000*10/1000 + 2000*30/1000 = 100+60 = 160
    // haiku: 8000*2/1000 + 1500*6/1000 = 16+9 = 25
    expect(result.totalMicroCredits).toBe("185");
    expect(result.models).toHaveLength(2);
  });

  it("skips zero-token meters without producing cost lines", () => {
    const result = estimateRunCredits(
      metering([
        {
          modelId: "claude-sonnet-4-20250514",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ]),
      [cap("claude-sonnet-4-20250514")],
    );
    expect(result.totalMicroCredits).toBe("0");
    expect(result.models[0]?.microCredits).toBe("0");
    expect(result.models[0]?.unpriced).toBe(false);
  });

  it("accounts for cache write tokens when priced", () => {
    const result = estimateRunCredits(
      metering([
        {
          modelId: "m",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 2000,
        },
      ]),
      [cap("m", "10", "20")],
    );
    // cache_write 2000 * 10/1000 = 20
    expect(result.totalMicroCredits).toBe("20");
  });
});
