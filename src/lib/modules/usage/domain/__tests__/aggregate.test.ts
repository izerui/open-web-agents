import {
  type RunUsageRecord,
  aggregateUsage,
  dayKey,
  formatUsd,
  toMicroUsd,
} from "@/lib/modules/usage/domain/aggregate";
import { describe, expect, it } from "vitest";

const D1 = Date.UTC(2026, 6, 20, 10, 0, 0);
const D2 = Date.UTC(2026, 6, 21, 10, 0, 0);

const rec = (over: Partial<RunUsageRecord> = {}): RunUsageRecord => ({
  runId: "r1",
  assistantId: "a1",
  assistantName: "助手甲",
  status: "success",
  costMicroUsd: 1_000_000,
  inputTokens: 100,
  outputTokens: 50,
  at: D1,
  ...over,
});

describe("aggregateUsage / 总计", () => {
  it("空输入得到全零", () => {
    const s = aggregateUsage([]);
    expect(s.totals).toEqual({
      runs: 0,
      succeeded: 0,
      failed: 0,
      costMicroUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(s.byAssistant).toEqual([]);
  });

  it("累加运行数、token 与花费", () => {
    const s = aggregateUsage([rec(), rec({ runId: "r2", costMicroUsd: 500_000 })]);
    expect(s.totals.runs).toBe(2);
    expect(s.totals.costMicroUsd).toBe(1_500_000);
    expect(s.totals.inputTokens).toBe(200);
    expect(s.totals.outputTokens).toBe(100);
  });

  it("分别统计成功与失败", () => {
    const s = aggregateUsage([
      rec(),
      rec({ runId: "r2", status: "failed" }),
      rec({ runId: "r3", status: "cancelled" }),
    ]);
    expect(s.totals).toMatchObject({ runs: 3, succeeded: 1, failed: 1 });
  });
});

describe("aggregateUsage / 按助手", () => {
  it("按助手分组并用名称作标签", () => {
    const s = aggregateUsage([
      rec(),
      rec({ runId: "r2", assistantId: "a2", assistantName: "助手乙" }),
    ]);
    expect(s.byAssistant).toHaveLength(2);
    expect(s.byAssistant.map((b) => b.label).sort()).toEqual(["助手乙", "助手甲"]);
  });

  it("花费高的排前面(看板第一眼看到钱花在哪)", () => {
    const s = aggregateUsage([
      rec({ assistantId: "cheap", costMicroUsd: 100 }),
      rec({ runId: "r2", assistantId: "pricey", costMicroUsd: 9_000_000 }),
    ]);
    expect(s.byAssistant[0]?.key).toBe("pricey");
  });

  it("缺名称时回退到 id", () => {
    const s = aggregateUsage([rec({ assistantName: undefined })]);
    expect(s.byAssistant[0]?.label).toBe("a1");
  });

  it("同一助手多次运行合并", () => {
    const s = aggregateUsage([rec(), rec({ runId: "r2" })]);
    expect(s.byAssistant).toHaveLength(1);
    expect(s.byAssistant[0]?.runs).toBe(2);
  });
});

describe("aggregateUsage / 按天", () => {
  it("按 UTC 日期分组且按时间升序", () => {
    const s = aggregateUsage([rec({ at: D2 }), rec({ runId: "r2", at: D1 })]);
    expect(s.byDay.map((b) => b.key)).toEqual(["2026-07-20", "2026-07-21"]);
  });

  it("同一天多次运行合并", () => {
    const s = aggregateUsage([rec({ at: D1 }), rec({ runId: "r2", at: D1 + 3600_000 })]);
    expect(s.byDay).toHaveLength(1);
    expect(s.byDay[0]?.runs).toBe(2);
  });
});

describe("dayKey", () => {
  it("用 UTC,不随服务器时区漂移", () => {
    expect(dayKey(Date.UTC(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(dayKey(Date.UTC(2026, 0, 6, 0, 1))).toBe("2026-01-06");
  });
});

describe("toMicroUsd", () => {
  it("USD 浮点转微美元整数", () => {
    expect(toMicroUsd(1.5)).toBe(1_500_000);
    expect(toMicroUsd(0.000001)).toBe(1);
  });
  it("非数值一律当 0,不产生 NaN 污染统计", () => {
    expect(toMicroUsd(null)).toBe(0);
    expect(toMicroUsd(undefined)).toBe(0);
    expect(toMicroUsd(Number.NaN)).toBe(0);
    expect(toMicroUsd(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("整数与小数都正确", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(1_500_000)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("不足一分向最近分位取整", () => {
    expect(formatUsd(5_000)).toBe("$0.01");
    expect(formatUsd(4_000)).toBe("$0.00");
  });
  it("大额不丢精度(整数运算)", () => {
    expect(formatUsd(123_456_780_000)).toBe("$123456.78");
  });
  it("负数带符号", () => {
    expect(formatUsd(-1_500_000)).toBe("-$1.50");
  });

  // 曾经的实现是「先取整数美元、再对余数四舍五入到分」,余数进位到 100 时不补位,
  // 于是 999900 输出 "$0.100" —— 人眼读作一毛钱,实为一块钱,差一个数量级。
  // 上面那几条用例的取值全落在不触发进位的区间,所以一直是绿的。
  it("【进位回归】余数进到 100 分时必须向美元位进位", () => {
    expect(formatUsd(999_900)).toBe("$1.00"); // 曾输出 $0.100
    expect(formatUsd(1_999_999)).toBe("$2.00"); // 曾输出 $1.100
    expect(formatUsd(1_996_000)).toBe("$2.00"); // 曾输出 $1.100
    expect(formatUsd(-999_900)).toBe("-$1.00");
  });

  it("输出恒为两位小数 —— 扫一圈边界而不是挑几个点", () => {
    for (let i = 0; i < 3000; i++) {
      expect(formatUsd(i * 997)).toMatch(/^\$\d+\.\d{2}$/);
    }
  });
});
