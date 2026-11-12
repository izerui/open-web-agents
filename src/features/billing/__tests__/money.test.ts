import { describe, expect, it } from "vitest";
import { formatPrice, parsePrice, priceParts } from "../money";

describe("package money strings", () => {
  it("converts prices without floating-point loss", () => {
    expect(parsePrice("9.90")).toBe("990");
    expect(parsePrice("0.01")).toBe("1");
    expect(parsePrice("9999999999999999.99")).toBe("999999999999999999");
    expect(formatPrice("990", "CNY")).toBe("9.90 CNY");
    expect(formatPrice("1", "USD")).toBe("0.01 USD");
  });
  it("rejects sub-cent precision, exponents and whitespace in canonical amounts", () => {
    for (const value of ["1.001", "-1", "1e2", "1\n", "01", "1 "]) {
      expect(() => parsePrice(value)).toThrow();
    }
  });
});

describe("priceParts:套餐价格写成「¥10 CNY」", () => {
  it("整元不带小数,带千分位", () => {
    expect(priceParts("1000", "CNY")).toEqual({ symbol: "¥", amount: "10", currency: "CNY" });
    expect(priceParts("8500000", "CNY").amount).toBe("85,000");
  });
  it("有分时保留两位", () => {
    expect(priceParts("1050", "USD")).toEqual({ symbol: "$", amount: "10.50", currency: "USD" });
  });
});
