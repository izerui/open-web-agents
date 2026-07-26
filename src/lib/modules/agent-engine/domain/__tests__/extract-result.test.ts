import { extractRunResult } from "@/lib/modules/agent-engine/domain/extract-result";
import { describe, expect, it } from "vitest";

describe("extractRunResult", () => {
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
    expect(r.cost).toEqual({ usd: 0.02, input: 100, output: 50 });
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

  it("通用助手(无 schema)success 无结构化 → 仍成功,只回文本", () => {
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

  it("无 schema 的通用助手不做提取(不该凭空造结构化结果)", () => {
    const r = extractRunResult({ subtype: "success", result: '{"a":1}' }, { hasSchema: false });
    expect(r.structured).toBeUndefined();
  });
});
