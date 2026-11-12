import { describe, expect, it } from "vitest";
import { llmPriceExample } from "../model-shared";

const M = 1_000_000;

describe("llmPriceExample:价目表下面的算价举例", () => {
  it("读 1 万 tokens、写 1,500 tokens 各要多少积分", () => {
    // 输入 300、输出 1500 积分每百万 token(原型里的 claude-sonnet-4-5)
    const rates = [
      { meter: "input_token", units: "1000000", microCredits: String(300 * M) },
      { meter: "output_token", units: "1000000", microCredits: String(1500 * M) },
    ] as const;
    expect(llmPriceExample("claude-sonnet-4-5", rates)).toBe(
      "例：用 claude-sonnet-4-5，一次读 1 万 tokens、写 1,500 tokens，约 3 + 2.25 = 5.25 积分。",
    );
  });

  it("单位不是百万也能折算", () => {
    const rates = [
      { meter: "input_token", units: "1000", microCredits: String(0.3 * M) },
      { meter: "output_token", units: "1000", microCredits: String(1.5 * M) },
    ] as const;
    expect(llmPriceExample("m", rates)).toContain("约 3 + 2.25 = 5.25 积分");
  });

  it("缺输入或输出价目时不举例", () => {
    expect(
      llmPriceExample("m", [{ meter: "input_token", units: "1000000", microCredits: "1" }]),
    ).toBeNull();
  });
});
