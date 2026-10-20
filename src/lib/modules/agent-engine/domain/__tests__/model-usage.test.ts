import { describe, expect, it } from "vitest";
import { combineResults } from "../../adapters/claude-sdk/runner";
import { extractRunResult } from "../extract-result";
import { extractModelUsage } from "../model-usage";

const tokens = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 20,
  cacheReadInputTokens: 300,
  cacheCreationInputTokens: 40,
});

describe("SDK model metering", () => {
  it("retains model identity and separates cache from ordinary input", () => {
    expect(extractModelUsage({ primary: tokens(10), child: tokens(5) })).toEqual({
      source: "sdk_model_usage",
      complete: true,
      models: [
        {
          modelId: "primary",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheWriteTokens: 40,
        },
        {
          modelId: "child",
          inputTokens: 5,
          outputTokens: 20,
          cacheReadTokens: 300,
          cacheWriteTokens: 40,
        },
      ],
    });
  });
  it("does not treat missing or malformed usage as zero cost", () => {
    for (const raw of [
      undefined,
      null,
      [],
      {},
      { m: { inputTokens: 3 } },
      { m: { ...tokens(1), outputTokens: -1 } },
      { m: tokens(Number.MAX_SAFE_INTEGER + 1) },
    ]) {
      expect(extractModelUsage(raw).complete).toBe(false);
    }
  });
  it("模型名非法但四项计数有效:计数记进未归属用量,不丢;不算计量缺失", () => {
    const m = extractModelUsage({ ok: tokens(10), ["x".repeat(201)]: tokens(7), "": tokens(1) });
    expect(m.models.map((u) => u.modelId)).toEqual(["ok"]);
    expect(m.unattributed).toEqual({
      inputTokens: 8,
      outputTokens: 40,
      cacheReadTokens: 600,
      cacheWriteTokens: 80,
    });
    expect(m.missing).toBeUndefined();
    expect(m.complete).toBe(false);
  });

  it("模型名非法但带合法的 canonicalModel:按 canonicalModel 归属", () => {
    const m = extractModelUsage({ ["x".repeat(201)]: { ...tokens(7), canonicalModel: "up-main" } });
    expect(m.models).toEqual([
      {
        modelId: "up-main",
        inputTokens: 7,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
      },
    ]);
    expect(m.unattributed).toBeUndefined();
  });

  it("个别计数读不出:读得出的照常计,读不出的记计量缺失;整项不是对象整项计缺失", () => {
    const m = extractModelUsage({
      ok: { ...tokens(10), outputTokens: -1 },
      half: { inputTokens: 5 },
      bad: null,
    });
    expect(m.models).toEqual([
      {
        modelId: "ok",
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
      },
      { modelId: "half", inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(m.missing).toBe(1 + 3 + 1);
    expect(m.complete).toBe(false);
  });

  it("preserves metering on failures and keeps old responses compatible", () => {
    const r = extractRunResult(
      { subtype: "error_max_turns", modelUsage: { m: tokens(2) } },
      { hasSchema: false },
    );
    expect(r.cost?.metering?.models[0]?.modelId).toBe("m");
    expect(r.cost?.metering?.complete).toBe(true);
    expect(extractRunResult({ subtype: "success" }, { hasSchema: false }).cost).not.toHaveProperty(
      "metering",
    );
  });
  it("takes the last cumulative model snapshot, never sums repeated snapshots", () => {
    const first = extractRunResult(
      { subtype: "success", modelUsage: { m: tokens(10) } },
      { hasSchema: false },
    );
    const last = extractRunResult(
      { subtype: "success", modelUsage: { m: tokens(30) } },
      { hasSchema: false },
    );
    expect(combineResults([first, last])?.cost?.metering?.models[0]?.inputTokens).toBe(30);
    expect(combineResults([first, last])?.cost?.metering?.complete).toBe(true);
  });
  it("preserves the SDK label and uses its explicit canonical model for prices", () => {
    const result = extractModelUsage({ "model[1m]": { ...tokens(2), canonicalModel: "model" } });
    expect(result.models[0]).toMatchObject({ modelId: "model", reportedModelId: "model[1m]" });
  });
});
