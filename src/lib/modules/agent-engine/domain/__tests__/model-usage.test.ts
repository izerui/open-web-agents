import { describe, expect, it } from "vitest";
import { combineResults } from "../../adapters/claude-sdk/runner";
import { extractRunResult } from "../extract-result";
import { extractModelUsage, mergeCumulative } from "../model-usage";

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

  it("个别计数读不出:读得出的照常计,读不出的记计量缺失并标出是哪项;整项不是对象的保留模型、四项都标读不出", () => {
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
        missingFields: ["outputTokens"],
      },
      {
        modelId: "half",
        inputTokens: 5,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        missingFields: ["outputTokens", "cacheReadTokens", "cacheWriteTokens"],
      },
      {
        modelId: "bad",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        missingFields: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"],
      },
    ]);
    expect(m.missing).toBe(1 + 3 + 1);
    expect(m.complete).toBe(false);
  });

  it("合并累计快照:读得出的字段采用新值,读不出的保留此前确认的值并继续标缺失;不相加", () => {
    const prev = extractModelUsage({
      "up-main": { ...tokens(10000), outputTokens: 1000 },
      sub: tokens(5),
    });
    const next = extractModelUsage({ "up-main": { ...tokens(20000), outputTokens: "x" } });
    const m = mergeCumulative(prev, next);
    expect(m.models).toEqual([
      {
        modelId: "up-main",
        inputTokens: 20000,
        outputTokens: 1000,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        missingFields: ["outputTokens"],
      },
      // 新快照没提到、也没有缺失的旧模型(sub):不沿用数量 —— 可能已含在新明细里
    ]);
    expect(m.missing).toBe(1);
    expect(m.complete).toBe(false);

    // 后来那份读得出:采用新值,缺失解除
    const fixed = mergeCumulative(
      m,
      extractModelUsage({ "up-main": { ...tokens(20000), outputTokens: 1500 } }),
    );
    expect(fixed.models[0]).toMatchObject({ inputTokens: 20000, outputTokens: 1500 });
    expect(fixed.models[0]?.missingFields).toBeUndefined();
    expect(fixed.missing).toBeUndefined();
  });

  it("合并累计快照:新快照没提到的模型不沿用数量,缺失标记照样沿用;后来明确补齐才解除", () => {
    const prev = extractModelUsage({
      "up-main": tokens(10000),
      "up-sub": { ...tokens(5000), outputTokens: "x" },
    });
    const onlyMain = mergeCumulative(prev, extractModelUsage({ "up-main": tokens(20000) }));
    // 数量不沿用(可能已含在新明细里),读不出的标记照样沿用
    expect(onlyMain.models.find((m) => m.modelId === "up-sub")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      missingFields: ["outputTokens"],
    });
    expect(onlyMain.missing).toBe(1);
    expect(onlyMain.complete).toBe(false);

    const filled = mergeCumulative(
      onlyMain,
      extractModelUsage({ "up-main": tokens(20000), "up-sub": tokens(5000) }),
    );
    expect(filled.missing).toBeUndefined();
    expect(filled.models.find((m) => m.modelId === "up-sub")?.missingFields).toBeUndefined();
  });

  it("合并累计快照:没提到的未归属部分、此前认不出身份且整项读不出的,缺失同样沿用", () => {
    const long = "x".repeat(201);
    const una = mergeCumulative(
      extractModelUsage({ "up-main": tokens(1), [long]: { ...tokens(100), outputTokens: -1 } }),
      extractModelUsage({ "up-main": tokens(2) }),
    );
    expect(una).toMatchObject({ unattributedMissing: ["outputTokens"], missing: 1 });

    const anonymous = mergeCumulative(
      extractModelUsage({ "up-main": tokens(1), [long]: null }),
      extractModelUsage({ "up-main": tokens(2) }),
    );
    expect(anonymous.missing).toBe(1);
  });

  it("合并累计快照:新快照没提到未归属部分(身份已修正)时不沿用旧数量,不重复计", () => {
    const long = "x".repeat(201);
    const m = mergeCumulative(
      extractModelUsage({ [long]: tokens(10000) }),
      extractModelUsage({ "up-main": tokens(20000) }),
    );
    expect(m.unattributed).toBeUndefined();
    expect(m.models.map((u) => [u.modelId, u.inputTokens])).toEqual([["up-main", 20000]]);
    expect(m.complete).toBe(true);
  });

  it("合并累计快照:未归属用量同样按字段合并", () => {
    const long = "x".repeat(201);
    const prev = extractModelUsage({ [long]: { ...tokens(100), outputTokens: 50 } });
    const next = extractModelUsage({ [long]: { ...tokens(200), outputTokens: -1 } });
    expect(mergeCumulative(prev, next).unattributed).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
    });
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
