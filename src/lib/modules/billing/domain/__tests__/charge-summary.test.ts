import { describe, expect, it } from "vitest";
import { SESSION_SOURCE_TO_CHARGE, summaryWindow, totalOf } from "../charge-summary";
import { monthWindowUtc } from "../run-charge";

describe("消耗汇总窗口", () => {
  const now = Date.UTC(2026, 2, 15, 8); // 2026-03-15
  it("本月与额度检查同一个自然月;上月是前一个自然月(跨年也对)", () => {
    expect(summaryWindow("this_month", now)).toEqual(monthWindowUtc(now));
    expect(summaryWindow("last_month", now)).toEqual({
      since: Date.UTC(2026, 1, 1),
      until: Date.UTC(2026, 2, 1),
    });
    expect(summaryWindow("last_month", Date.UTC(2026, 0, 3))).toEqual({
      since: Date.UTC(2025, 11, 1),
      until: Date.UTC(2026, 0, 1),
    });
  });
  it("近 N 天包含现在", () => {
    const w = summaryWindow("30d", now);
    expect(w.since).toBe(now - 30 * 86_400_000);
    expect(w.until).toBeGreaterThan(now);
  });
});

describe("来源映射与合计", () => {
  it("api 与 invoke 合并为 API 调用", () => {
    expect(SESSION_SOURCE_TO_CHARGE.api).toBe("api");
    expect(SESSION_SOURCE_TO_CHARGE.invoke).toBe("api");
  });
  it("各列分别相加,不丢精度", () => {
    const row = (used: string) => ({
      key: null,
      name: null,
      runs: 1,
      chargedMicro: used,
      owedMicro: "0",
      reservedMicro: "0",
      usedMicro: used,
    });
    expect(totalOf([row("9007199254740993"), row("1")]).usedMicro).toBe("9007199254740994");
    expect(totalOf([]).runs).toBe(0);
  });
});
