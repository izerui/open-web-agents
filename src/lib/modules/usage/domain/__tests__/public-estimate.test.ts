import { describe, expect, it } from "vitest";
import type { RunCreditEstimate } from "../estimate";
import { toPublicEstimate } from "../public-estimate";

const est: RunCreditEstimate = {
  totalMicroCredits: "500",
  complete: true,
  source: "sdk_model_usage",
  models: [
    {
      modelId: "up-a",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      microCredits: "500",
      unpriced: false,
    },
    {
      modelId: "up-unknown",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      microCredits: null,
      unpriced: true,
    },
  ],
};
const cap = (id: string, modelId: string, providerId: string, version = 3) => ({
  id,
  name: `名-${id}`,
  modelId,
  version,
  kind: "llm" as const,
  providerId,
});

describe("toPublicEstimate", () => {
  it("上游标识换成公开 id、名称与价目版本;token 与积分保留;认不出的不给 id", () => {
    const out = toPublicEstimate(est, [cap("m-a", "up-a", "p1")]);
    expect(JSON.stringify(out)).not.toContain("up-");
    expect(out.models).toEqual([
      {
        model: "m-a",
        name: "名-m-a",
        version: 3,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        microCredits: "500",
        unpriced: false,
      },
      {
        model: null,
        name: "未识别的模型",
        version: null,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        microCredits: null,
        unpriced: true,
      },
    ]);
    expect(out.totalMicroCredits).toBe("500");
  });

  it("同一上游标识在多个提供者下:按运行所属提供者区分,区分不了就不给 id", () => {
    const catalog = [cap("m-a", "up-a", "p1"), cap("m-b", "up-a", "p2")];
    expect(toPublicEstimate(est, catalog, "p2").models[0]?.model).toBe("m-b");
    expect(toPublicEstimate(est, catalog).models[0]?.model).toBeNull();
  });
});
