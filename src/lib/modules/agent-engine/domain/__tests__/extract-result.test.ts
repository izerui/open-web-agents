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
