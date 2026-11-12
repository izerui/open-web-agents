import { describe, expect, it } from "vitest";
import { EVAL_ESTIMATE_SAMPLES, estimateEvalCost } from "../cost-estimate";

describe("评测花费预估", () => {
  it("平均实扣 × 用例数,整数微积分,四舍五入到个位", () => {
    expect(estimateEvalCost({ cases: 3, model: "sonnet", samples: ["100", "200", "301"] })).toEqual(
      {
        cases: 3,
        model: "sonnet",
        samples: 3,
        avgMicroCredits: "200", // 601 / 3 = 200.33
        totalMicroCredits: "600",
      },
    );
    expect(estimateEvalCost({ cases: 2, model: "m", samples: ["1", "2"] })).toMatchObject({
      avgMicroCredits: "2", // 1.5 → 2
      totalMicroCredits: "4",
    });
  });

  it("超过 2^53 也不丢精度(BigInt,不走浮点)", () => {
    const big = "9007199254740993";
    expect(estimateEvalCost({ cases: 10, model: "m", samples: [big, big] })).toMatchObject({
      avgMicroCredits: big,
      totalMicroCredits: "90071992547409930",
    });
  });

  it("一条样本都没有:avg/total 为 null", () => {
    expect(estimateEvalCost({ cases: 5, model: "haiku", samples: [] })).toEqual({
      cases: 5,
      model: "haiku",
      samples: 0,
      avgMicroCredits: null,
      totalMicroCredits: null,
    });
  });

  it("非法样本(非整数串)忽略;最多取前 20 条", () => {
    expect(
      estimateEvalCost({ cases: 1, model: "m", samples: ["abc", "", "-5", "10", "1.5"] }),
    ).toMatchObject({ samples: 1, avgMicroCredits: "10" });
    const many = Array.from({ length: 30 }, (_, i) => (i < EVAL_ESTIMATE_SAMPLES ? "10" : "1000"));
    expect(estimateEvalCost({ cases: 1, model: "m", samples: many })).toMatchObject({
      samples: EVAL_ESTIMATE_SAMPLES,
      avgMicroCredits: "10",
    });
  });

  it("没有用例:有样本时总额为 0", () => {
    expect(estimateEvalCost({ cases: 0, model: "m", samples: ["10"] })).toMatchObject({
      cases: 0,
      avgMicroCredits: "10",
      totalMicroCredits: "0",
    });
  });
});
