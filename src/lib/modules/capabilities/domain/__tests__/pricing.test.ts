import { describe, expect, it } from "vitest";
import { priceUsage, validateCapability } from "../catalog";
import {
  MAX_MARKUP_BP,
  deriveSaleRates,
  formatMarkupPercent,
  formatYuan,
  markupMarginWarning,
  parseMarkupPercent,
  parseYuan,
} from "../pricing";

const sonnetCost = [
  { meter: "input_token" as const, units: "1000000", microCredits: parseYuan("21") },
  { meter: "output_token" as const, units: "1000000", microCredits: parseYuan("105") },
  { meter: "cache_read_token" as const, units: "1000000", microCredits: parseYuan("2.1") },
  { meter: "cache_write_token" as const, units: "1000000", microCredits: parseYuan("26.25") },
];

const base = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  kind: "llm",
  modelId: "claude-sonnet-4-5",
  enabled: true,
  acceptsImages: false,
  providerId: "platform-default",
};

describe("元与微积分换算", () => {
  it("1 元 = 100 积分 = 1e8 微积分,8 位小数无损", () => {
    expect(parseYuan("21")).toBe("2100000000");
    expect(parseYuan("0")).toBe("0");
    expect(parseYuan("0.00000001")).toBe("1");
    expect(parseYuan("26.25")).toBe("2625000000");
    for (const v of ["21", "0.00000001", "26.25", "1234.5678"]) {
      expect(formatYuan(parseYuan(v))).toBe(v);
    }
  });

  it("拒绝负数、超过 8 位小数、科学计数法与空白", () => {
    for (const bad of ["-1", "1.123456789", "1e3", "", " 1", "01", "1."]) {
      expect(() => parseYuan(bad)).toThrow();
    }
  });
});

describe("加价比例", () => {
  it("百分比 ↔ 万分比,最多 2 位小数,上限 1000%", () => {
    expect(parseMarkupPercent("10")).toBe(1000);
    expect(parseMarkupPercent("12.5")).toBe(1250);
    expect(parseMarkupPercent("0")).toBe(0);
    expect(parseMarkupPercent("1000")).toBe(MAX_MARKUP_BP);
    expect(formatMarkupPercent(1250)).toBe("12.5");
    expect(formatMarkupPercent(1000)).toBe("10");
    for (const bad of ["1000.01", "1.234", "-1", "abc"]) {
      expect(() => parseMarkupPercent(bad)).toThrow();
    }
  });

  it("加价不高于 8% 提醒:恰好 8% 也提醒", () => {
    expect(markupMarginWarning(0)).toBe(true);
    expect(markupMarginWarning(800)).toBe(true);
    expect(markupMarginWarning(801)).toBe(false);
  });
});

describe("售价派生", () => {
  it("售价 = 成本 × (1 + 加价),逐项向上取整", () => {
    const sale = deriveSaleRates(sonnetCost, 1000);
    expect(sale.map((r) => r.microCredits)).toEqual([
      "2310000000",
      "11550000000",
      "231000000",
      "2887500000",
    ]);
    expect(
      deriveSaleRates([{ meter: "image", units: "1", microCredits: "1" }], 1)[0]?.microCredits,
    ).toBe("2");
    expect(
      deriveSaleRates([{ meter: "image", units: "1", microCredits: "0" }], 1000)[0]?.microCredits,
    ).toBe("0");
  });

  it("设计示例:sonnet 加价 10%,输入 2 万 + 缓存读 1 万 + 输出 1 千 = 60.06 积分", () => {
    const model = validateCapability({ ...base, costRates: sonnetCost, markupBp: 1000 });
    const charged = priceUsage(model.rates, {
      input_token: "20000",
      cache_read_token: "10000",
      output_token: "1000",
    });
    expect(charged.microCredits).toBe("60060000");
    const cost = priceUsage(model.costRates ?? [], {
      input_token: "20000",
      cache_read_token: "10000",
      output_token: "1000",
    });
    expect(cost.microCredits).toBe("54600000");
  });
});

describe("模型定义校验", () => {
  it("有成本价时售价由服务端派生,忽略传入的 rates", () => {
    const model = validateCapability({
      ...base,
      costRates: sonnetCost,
      markupBp: 1000,
      rates: [{ meter: "input_token", units: "1", microCredits: "1" }],
    });
    expect(model.rates[0]).toEqual({
      meter: "input_token",
      units: "1000000",
      microCredits: "2310000000",
    });
    expect(model.markupBp).toBe(1000);
    expect(model.providerId).toBe("platform-default");
  });

  it("加价须与成本价一起出现,且为合法万分比", () => {
    expect(() => validateCapability({ ...base, rates: sonnetCost, markupBp: 1000 })).toThrow(
      /成本价/,
    );
    for (const bad of [-1, 1.5, MAX_MARKUP_BP + 1, "10", undefined]) {
      expect(() => validateCapability({ ...base, costRates: sonnetCost, markupBp: bad })).toThrow();
    }
  });

  it("成本价同样校验计量项与类型匹配", () => {
    expect(() =>
      validateCapability({
        ...base,
        costRates: [{ meter: "image", units: "1", microCredits: "1" }],
        markupBp: 0,
      }),
    ).toThrow(/类型/);
  });

  it("模型 ID 不得占用别名;提供者 ID 须为合法标识", () => {
    for (const id of ["fable", "opus", "sonnet", "haiku"]) {
      expect(() => validateCapability({ ...base, id, costRates: sonnetCost, markupBp: 0 })).toThrow(
        /别名/,
      );
    }
    expect(() =>
      validateCapability({ ...base, providerId: "Bad Id", costRates: sonnetCost, markupBp: 0 }),
    ).toThrow(/提供者/);
  });

  it("旧数据(无成本价)保持原样", () => {
    const { providerId: _, ...legacy } = base;
    const model = validateCapability({ ...legacy, rates: sonnetCost });
    expect(model.rates).toEqual(sonnetCost);
    expect(model.costRates).toBeUndefined();
    expect(model.providerId).toBeUndefined();
  });
});
