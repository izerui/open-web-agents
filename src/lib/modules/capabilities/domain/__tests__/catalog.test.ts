import { describe, expect, it } from "vitest";
import { formatCredits, parseCredits, priceUsage, validateCapability } from "../catalog";

const llm = {
  id: "standard",
  name: "标准模型",
  kind: "llm",
  modelId: "provider-model",
  enabled: true,
  acceptsImages: true,
  rates: [
    { meter: "input_token" as const, units: "1000000", microCredits: "12000000" },
    { meter: "output_token" as const, units: "1000000", microCredits: "60000000" },
  ],
};

describe("capability catalog", () => {
  it("vision understanding belongs to LLM, image generation uses image units", () => {
    expect(validateCapability(llm).kind).toBe("llm");
    expect(
      validateCapability({
        ...llm,
        kind: "image",
        acceptsImages: false,
        rates: [{ meter: "image", units: "1", microCredits: "500000" }],
      }).kind,
    ).toBe("image");
    expect(() => validateCapability({ ...llm, kind: "video" })).toThrow();
  });
  it("requires explicit prices before enabling a model", () => {
    expect(() => validateCapability({ ...llm, id: "model\n" })).toThrow();
    expect(() => validateCapability({ ...llm, rates: [] })).toThrow(/价目/);
    expect(validateCapability({ ...llm, enabled: false, rates: [] }).enabled).toBe(false);
  });
  it("rejects duplicate, negative, decimal and zero-denominator rates", () => {
    expect(() => validateCapability({ ...llm, rates: [llm.rates[0], llm.rates[0]] })).toThrow(
      /重复/,
    );
    for (const bad of [
      { units: "0", microCredits: "1" },
      { units: "1", microCredits: "-1" },
      { units: "1.5", microCredits: "1" },
      { units: "1", microCredits: "1e9" },
      { units: "1", microCredits: "1\n" },
    ]) {
      expect(() =>
        validateCapability({ ...llm, rates: [{ meter: "input_token", ...bad }] }),
      ).toThrow();
    }
  });
  it("prices inputs and outputs separately with integer arithmetic", () => {
    expect(priceUsage(llm.rates, { input_token: "1000", output_token: "500" }).microCredits).toBe(
      "42000",
    );
    expect(
      priceUsage(
        [
          {
            meter: "image",
            units: "1",
            microCredits: "500000",
          },
        ],
        { image: "3" },
      ).microCredits,
    ).toBe("1500000");
    expect(
      priceUsage(
        [
          {
            meter: "video_ms",
            units: "1000",
            microCredits: "2000000",
          },
        ],
        { video_ms: "1500" },
      ).microCredits,
    ).toBe("3000000");
  });
  it("never prices unknown/missing meters as free", () => {
    expect(() => priceUsage(llm.rates, { cache_read_token: "10" })).toThrow(/缺少/);
    expect(() => priceUsage(llm.rates, JSON.parse('{"unrecognized":"1"}'))).toThrow(/未知/);
    expect(priceUsage(llm.rates, { cache_read_token: "0" }).microCredits).toBe("0");
  });
  it("rounds fractions to microcredits and handles values beyond Number precision", () => {
    expect(
      priceUsage(
        [
          {
            meter: "input_token",
            units: "3",
            microCredits: "1",
          },
        ],
        { input_token: "1" },
      ).microCredits,
    ).toBe("1");
    expect(
      priceUsage(
        [
          {
            meter: "input_token",
            units: "1",
            microCredits: "2",
          },
        ],
        { input_token: "9007199254740993" },
      ).microCredits,
    ).toBe("18014398509481986");
  });
  it("converts display credits without float rounding", () => {
    expect(parseCredits("0.000001")).toBe("1");
    expect(parseCredits("123.450006")).toBe("123450006");
    expect(formatCredits("123450006")).toBe("123.450006");
    expect(formatCredits("1000000")).toBe("1");
    expect(() => parseCredits("0.0000001")).toThrow();
    expect(() => parseCredits("-1")).toThrow();
  });
});
