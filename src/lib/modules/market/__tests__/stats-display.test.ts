import { describe, expect, it } from "vitest";
import { formatPerRun, formatUseCount } from "../domain/display";
import { authorOf, avgCreditsOf } from "../domain/stats";

describe("authorOf", () => {
  it("取邮箱 @ 前的部分", () => {
    expect(authorOf("lin.zhou@xinghe.example")).toBe("lin.zhou");
  });
  it("没有邮箱或格式不对时为 null", () => {
    expect(authorOf(undefined)).toBeNull();
    expect(authorOf("")).toBeNull();
    expect(authorOf("@x.com")).toBeNull();
  });
  it("没有 @ 时原样返回", () => {
    expect(authorOf("local-admin")).toBe("local-admin");
  });
});

describe("avgCreditsOf", () => {
  it("微积分平均值换算成积分", () => {
    expect(avgCreditsOf("2340000.0000")).toBeCloseTo(2.34);
    expect(avgCreditsOf(1_500_000)).toBe(1.5);
  });
  it("没有数据或不是数字时为 null", () => {
    expect(avgCreditsOf(null)).toBeNull();
    expect(avgCreditsOf(undefined)).toBeNull();
    expect(avgCreditsOf("abc")).toBeNull();
  });
});

describe("formatUseCount", () => {
  it("不足一万按千分位", () => {
    expect(formatUseCount(0)).toBe("暂无使用");
    expect(formatUseCount(7)).toBe("7 次使用");
    expect(formatUseCount(1234)).toBe("1,234 次使用");
  });
  it("一万以上按万，保留一位小数", () => {
    expect(formatUseCount(10000)).toBe("1 万次使用");
    expect(formatUseCount(18000)).toBe("1.8 万次使用");
    expect(formatUseCount(64321)).toBe("6.4 万次使用");
  });
});

describe("formatPerRun", () => {
  it("没有数据时为 null(界面改显示模型单价)", () => {
    expect(formatPerRun(null)).toBeNull();
    expect(formatPerRun(undefined)).toBeNull();
  });
  it("按大小取精度", () => {
    expect(formatPerRun(0)).toBe("不到 0.01 积分/次");
    expect(formatPerRun(0.004)).toBe("不到 0.01 积分/次");
    expect(formatPerRun(0.5)).toBe("约 0.5 积分/次");
    expect(formatPerRun(0.123)).toBe("约 0.12 积分/次");
    expect(formatPerRun(2)).toBe("约 2 积分/次");
    expect(formatPerRun(2.34)).toBe("约 2.3 积分/次");
    expect(formatPerRun(12.6)).toBe("约 13 积分/次");
    expect(formatPerRun(12345)).toBe("约 12,345 积分/次");
  });
});
