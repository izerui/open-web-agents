import { describe, expect, it } from "vitest";
import { creditsAmount, creditsBalance, creditsExact } from "../credits-display";

describe("积分显示", () => {
  it("金额:≥0.01 两位小数四舍五入,不足 0.01 显示 < 0.01", () => {
    expect(creditsAmount("0")).toBe("0");
    expect(creditsAmount("1")).toBe("< 0.01");
    expect(creditsAmount("9999")).toBe("< 0.01");
    expect(creditsAmount("10000")).toBe("0.01");
    expect(creditsAmount("57750000")).toBe("57.75");
    expect(creditsAmount("57754999")).toBe("57.75");
    expect(creditsAmount("57755000")).toBe("57.76");
    expect(creditsAmount("1234567000000")).toBe("1,234,567.00");
  });

  it("余额向下取整,不多显示", () => {
    expect(creditsBalance("19999999")).toBe("19.99");
    expect(creditsBalance("9999")).toBe("0.00");
    expect(creditsBalance(1000n * 1_000_000n)).toBe("1,000.00");
  });

  it("明细六位小数", () => {
    expect(creditsExact("57750001")).toBe("57.750001");
    expect(creditsExact("1")).toBe("0.000001");
  });
});
