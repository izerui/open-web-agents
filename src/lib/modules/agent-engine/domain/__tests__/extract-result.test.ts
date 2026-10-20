import { extractRunResult } from "@/lib/modules/agent-engine/domain/extract-result";
import { describe, expect, it } from "vitest";

describe("extractRunResult", () => {
  describe("计量:result 的四项 usage", () => {
    const res = (extra: Record<string, unknown>) =>
      extractRunResult(
        {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 10000,
            cache_creation_input_tokens: 300,
          },
          ...extra,
        },
        { hasSchema: false },
      ).cost?.metering;

    it("没有 modelUsage:缓存读、缓存写也保留,记为未归属用量", () => {
      expect(res({})).toEqual({
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 10000,
          cacheWriteTokens: 300,
        },
        fromResultUsage: true,
      });
    });

    it("modelUsage 给不出任何模型明细:同样记为未归属用量", () => {
      expect(res({ modelUsage: {} })?.unattributed).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 10000,
        cacheWriteTokens: 300,
      });
    });

    it("有按模型的明细:只用明细,不再另记未归属(不重复)", () => {
      const m = res({
        modelUsage: {
          "up-main": {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 10000,
            cacheCreationInputTokens: 300,
          },
        },
      });
      expect(m?.unattributed).toBeUndefined();
      expect(m?.models).toHaveLength(1);
    });

    it("计数明确给出却读不出(负数、字符串):读得出的照常计,读不出的记计量缺失,不当零", () => {
      const r = extractRunResult(
        {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: { input_tokens: 10000, output_tokens: -1, cache_read_input_tokens: "5" },
        },
        { hasSchema: false },
      );
      expect(r.cost).toMatchObject({ input: 10000, output: 0 });
      expect(r.cost?.metering).toEqual({
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: {
          inputTokens: 10000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        missing: 2,
        fromResultUsage: true,
      });
    });

    it("有效的零、省略或为 null 的缓存项:都不算异常", () => {
      const m = extractRunResult(
        {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: { input_tokens: 10000, output_tokens: 0, cache_creation_input_tokens: null },
        },
        { hasSchema: false },
      ).cost?.metering;
      expect(m?.missing).toBeUndefined();
      expect(m?.unattributed).toEqual({
        inputTokens: 10000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("只有读不出的计数、没有任何可用计数:仍留下计量缺失,不能按零结清", () => {
      for (const usage of [{ input_tokens: -1 }, "garbled"]) {
        const m = extractRunResult(
          { type: "result", subtype: "success", result: "ok", usage },
          { hasSchema: false },
        ).cost?.metering;
        expect(m).toMatchObject({ complete: false, models: [], missing: 1 });
        expect(m?.unattributed).toBeUndefined();
      }
    });

    it("一点用量都没有:不造计量", () => {
      expect(
        extractRunResult(
          { type: "result", subtype: "success", result: "ok", usage: {} },
          { hasSchema: false },
        ).cost?.metering,
      ).toBeUndefined();
    });
  });

  it("success + structured_output → 成功并取值", () => {
    const r = extractRunResult(
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 50 },
        structured_output: { videoId: "v1" },
      },
      { hasSchema: true },
    );
    expect(r.status).toBe("success");
    expect(r.structured).toEqual({ videoId: "v1" });
    expect(r.summary).toBe("done");
    expect(r.cost).toEqual({
      usd: 0.02,
      input: 100,
      output: 50,
      metering: {
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        fromResultUsage: true,
      },
    });
  });

  // 真实样本(开发环境 2026-10-12):上游网关 503,SDK 照样给 subtype:"success",
  // 失败信号只在 is_error / api_error_status 上 —— 只看 subtype 会把报错文本记成"成功的回答"
  it("subtype 是 success 但 is_error=true(上游 API 报错)→ 失败,不把报错文本当回答", () => {
    const r = extractRunResult(
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 503,
        result: "API Error: 503 Service temporarily unavailable.",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        structured_output: { leftover: true },
      },
      { hasSchema: true },
    );
    expect(r.status).toBe("failed");
    expect(r.error).toEqual({
      kind: "api_error",
      message: "API Error: 503 Service temporarily unavailable.",
      status: 503,
    });
    expect(r.structured).toBeUndefined();
  });

  it("is_error=false 的 success 仍是成功", () => {
    const r = extractRunResult(
      { subtype: "success", is_error: false, result: "ok" },
      { hasSchema: false },
    );
    expect(r.status).toBe("success");
  });

  it("错误 subtype → 失败,且不采信残留 structured_output", () => {
    const r = extractRunResult(
      { subtype: "error_max_turns", result: "gave up", structured_output: { leftover: true } },
      { hasSchema: true },
    );
    expect(r.status).toBe("failed");
    expect(r.structured).toBeUndefined();
    expect(r.error?.kind).toBe("error_max_turns");
  });

  it("声明了 schema 却没产出结构化结果 → 失败(契约缺失)", () => {
    const r = extractRunResult({ subtype: "success", result: "ok" }, { hasSchema: true });
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("no_structured_output");
  });

  it("通用智能体(无 schema)success 无结构化 → 仍成功,只回文本", () => {
    const r = extractRunResult({ subtype: "success", result: "just text" }, { hasSchema: false });
    expect(r.status).toBe("success");
    expect(r.summary).toBe("just text");
    expect(r.structured).toBeUndefined();
  });

  it("缺 usage/cost 字段时给零值", () => {
    const r = extractRunResult({ subtype: "success", result: "x" }, { hasSchema: false });
    expect(r.cost).toEqual({ usd: 0, input: 0, output: 0 });
  });

  it("空消息安全降级为失败", () => {
    const r = extractRunResult(null, { hasSchema: false });
    expect(r.status).toBe("failed");
  });
});

describe("兼容网关降级:从文本提取结构化结果", () => {
  it("缺 structured_output 但文本里有 JSON → 提取并标记降级", () => {
    const r = extractRunResult(
      { subtype: "success", result: '结论如下:\n```json\n{"verdict":"pass","score":88}\n```' },
      { hasSchema: true },
    );
    expect(r.status).toBe("success");
    expect(r.structured).toEqual({ verdict: "pass", score: 88 });
    expect(r.salvagedFromText).toBe(true);
  });

  // 判定曾是 `=== undefined`,只覆盖「字段缺失」。而第三方兼容网关(DashScope/GLM)
  // 不支持 output_format 时返回的是显式的 `"structured_output": null` ——
  // 整段降级被跳过,最后以笼统的 schema_mismatch 失败。
  // 这个分支存在的全部理由就是应对这些网关,却对它们最常见的返回形态失效;
  // 上面那条用例用的是「字段缺失」,所以一直是绿的。
  it("【降级回归】structured_output 为显式 null 时同样走文本提取", () => {
    const r = extractRunResult(
      { subtype: "success", structured_output: null, result: '结果:{"a":1}' },
      { hasSchema: true },
    );
    expect(r.status).toBe("success");
    expect(r.structured).toEqual({ a: 1 });
    expect(r.salvagedFromText).toBe(true);
  });

  it("显式 null 且文本里也提不出 JSON 时,才以 no_structured_output 失败", () => {
    const r = extractRunResult(
      { subtype: "success", structured_output: null, result: "抱歉,我没法完成" },
      { hasSchema: true },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("no_structured_output");
  });

  it("原生 structured_output 优先,不走降级", () => {
    const r = extractRunResult(
      { subtype: "success", result: '{"from":"text"}', structured_output: { from: "native" } },
      { hasSchema: true },
    );
    expect(r.structured).toEqual({ from: "native" });
    expect(r.salvagedFromText).toBeUndefined();
  });

  it("文本里也没有 JSON → 仍判失败,不伪造成功", () => {
    const r = extractRunResult(
      { subtype: "success", result: "我没法给出结构化结果" },
      { hasSchema: true },
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("no_structured_output");
  });

  it("错误 subtype 下不尝试降级提取", () => {
    const r = extractRunResult(
      { subtype: "error_max_turns", result: '{"a":1}' },
      { hasSchema: true },
    );
    expect(r.status).toBe("failed");
    expect(r.structured).toBeUndefined();
  });

  it("无 schema 的通用智能体不做提取(不该凭空造结构化结果)", () => {
    const r = extractRunResult({ subtype: "success", result: '{"a":1}' }, { hasSchema: false });
    expect(r.structured).toBeUndefined();
  });
});
