import { describe, expect, it } from "vitest";
import { barWidths, compactCount, dayTicks, fillDays, successRate } from "../usage-display";

describe("barWidths:按智能体的横条", () => {
  it("总长按最大值,内部按成功/失败分段", () => {
    expect(barWidths({ runs: 10, failed: 2 }, 20)).toEqual({ total: 50, ok: 80, failed: 20 });
  });
  it("最大值为 0 或没有运行时宽度为 0", () => {
    expect(barWidths({ runs: 0, failed: 0 }, 0)).toEqual({ total: 0, ok: 0, failed: 0 });
  });
  it("有运行的至少 2%", () => {
    expect(barWidths({ runs: 1, failed: 0 }, 1000).total).toBe(2);
  });
});

describe("successRate", () => {
  it("无运行 = null,否则保留一位小数", () => {
    expect(successRate({ runs: 0, succeeded: 0 })).toBeNull();
    expect(successRate({ runs: 3, succeeded: 2 })).toBe(66.7);
    expect(successRate({ runs: 4, succeeded: 4 })).toBe(100);
  });
});

describe("dayTicks:按天柱状图的横轴标签", () => {
  it("取首、中、末", () => {
    expect(dayTicks(["a", "b", "c", "d", "e"])).toEqual(["a", "c", "e"]);
  });
  it("少于 3 天只给首末", () => {
    expect(dayTicks(["a", "b"])).toEqual(["a", "b"]);
    expect(dayTicks(["a"])).toEqual(["a"]);
    expect(dayTicks([])).toEqual([]);
  });
});

describe("fillDays:没有运行的日子补 0", () => {
  const now = Date.UTC(2026, 10, 12, 3);
  it("按 UTC 日期补齐窗口内每一天,保留已有数据", () => {
    const days = fillDays([{ key: "2026-11-11", runs: 4, failed: 1 }], 3, now);
    expect(days).toEqual([
      { key: "2026-11-10", runs: 0, failed: 0 },
      { key: "2026-11-11", runs: 4, failed: 1 },
      { key: "2026-11-12", runs: 0, failed: 0 },
    ]);
  });
  it("最近 1 天跨两个 UTC 日期", () => {
    expect(fillDays([], 1, now).map((d) => d.key)).toEqual(["2026-11-11", "2026-11-12"]);
  });
});

describe("compactCount", () => {
  it.each([
    [999, "999"],
    [1200, "1.2k"],
    [16_300_000, "16.3M"],
    [2_000_000, "2M"],
  ])("%s → %s", (n, s) => {
    expect(compactCount(n)).toBe(s);
  });
});
