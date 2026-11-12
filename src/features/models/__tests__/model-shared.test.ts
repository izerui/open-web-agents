import { describe, expect, it } from "vitest";
import { llmPriceExample, markupHint } from "../model-shared";

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

describe("markupHint:加价比例的实时提示", () => {
  it("超过 1000% 实时报错,不等点保存", () => {
    expect(markupHint("1500")).toEqual({ tone: "bad", text: "加价比例不能超过 1000%" });
  });
  it("格式不对也实时报错", () => {
    expect(markupHint("abc")?.tone).toBe("bad");
    expect(markupHint("1.234")?.tone).toBe("bad");
  });
  it("不高于充值赠送比例时警告,写明具体比例", () => {
    expect(markupHint("5")).toEqual({
      tone: "warn",
      text: "加价 5% 不高于充值赠送比例（最高 8%）：用户用赠送积分调用这个模型时，平台可能没有成本余量甚至亏本。",
    });
  });
  it("正常范围没有提示", () => {
    expect(markupHint("10")).toBeNull();
    expect(markupHint("1000")).toBeNull();
  });
});
