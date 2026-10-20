import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import { priceForSettlement } from "../settle-pricing";

const cap = (id: string, modelId: string, inputPerM: string): Capability => ({
  id,
  name: id,
  kind: "llm",
  modelId,
  enabled: true,
  acceptsImages: false,
  providerId: "p",
  rates: [
    { meter: "input_token", units: "1000000", microCredits: inputPerM },
    { meter: "output_token", units: "1000000", microCredits: "10000000000" },
    { meter: "cache_read_token", units: "1000000", microCredits: "100000000" },
    { meter: "cache_write_token", units: "1000000", microCredits: "1000000000" },
  ],
  version: 1,
  updatedAt: 0,
});
// 主模型:输入 2000 积分/百万;子代理模型:输入 500 积分/百万
const MAIN = cap("m-main", "up-main", "2000000000");
const SUB = cap("m-sub", "up-sub", "500000000");
const metering = (models: [string, number][]) => ({
  metering: {
    source: "sdk_model_usage",
    complete: true,
    models: models.map(([modelId, inputTokens]) => ({
      modelId,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })),
  },
});

describe("结算计价", () => {
  it("认得出的模型各按自己的售价", () => {
    expect(
      priceForSettlement(
        metering([
          ["up-main", 1_000_000],
          ["up-sub", 1_000_000],
        ]),
        [MAIN, SUB],
        "m-main",
      ),
    ).toEqual({ priceable: true, micro: 2_500_000_000n, fallbackTokens: 0 });
  });

  it("认不出的按主模型售价,并报告兜底的 token 数", () => {
    expect(
      priceForSettlement(
        metering([
          ["up-sub", 1_000_000],
          ["renamed", 1_000_000],
        ]),
        [MAIN, SUB],
        "m-main",
      ),
    ).toEqual({ priceable: true, micro: 2_500_000_000n, fallbackTokens: 1_000_000 });
  });

  it("没有按模型的明细:总 token 按主模型价;没有用量为 0", () => {
    expect(priceForSettlement({ input: 1_000_000, output: 0 }, [MAIN], "m-main")).toEqual({
      priceable: true,
      micro: 2_000_000_000n,
      fallbackTokens: 1_000_000,
    });
    expect(priceForSettlement({ input: 0, output: 0 }, [MAIN], "m-main").micro).toBe(0n);
  });

  // 未归属:1M 输入(主模型 2000)+ 1M 缓存读(100)+ 1M 缓存写(1000)= 3100 积分
  const UNATTRIBUTED = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };

  it("有按模型的明细、又有没带模型名的用量:两部分都计,后者按主模型价、缓存分开计", () => {
    const cost = metering([["up-sub", 1_000_000]]);
    expect(
      priceForSettlement(
        { ...cost, metering: { ...cost.metering, complete: false, unattributed: UNATTRIBUTED } },
        [MAIN, SUB],
        "m-main",
      ),
    ).toEqual({ priceable: true, micro: 3_600_000_000n, fallbackTokens: 3_000_000 });
  });

  it("只有没带模型名的用量:按四项分开计,不用总数(总数里的缓存会被当成普通输入多算)", () => {
    expect(
      priceForSettlement(
        {
          input: 3_000_000,
          output: 0,
          metering: {
            source: "sdk_model_usage",
            complete: false,
            models: [],
            unattributed: UNATTRIBUTED,
          },
        },
        [MAIN],
        "m-main",
      ),
    ).toEqual({ priceable: true, micro: 3_100_000_000n, fallbackTokens: 3_000_000 });
  });

  it("没带模型名的用量也取不到主模型价目:算不出", () => {
    const cost = metering([["up-sub", 1]]);
    expect(
      priceForSettlement(
        { ...cost, metering: { ...cost.metering, unattributed: UNATTRIBUTED } },
        [SUB],
        "m-main",
      ).priceable,
    ).toBe(false);
  });

  it("取不到主模型价目:算不出", () => {
    expect(priceForSettlement(metering([["renamed", 1]]), [SUB], "m-main").priceable).toBe(false);
    expect(priceForSettlement(metering([["up-main", 1]]), null, "m-main").priceable).toBe(false);
  });
});
