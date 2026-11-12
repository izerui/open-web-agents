import { describe, expect, it } from "vitest";
import {
  batchSummary,
  billingTab,
  chargeStatus,
  countEmails,
  creditsToYuan,
  ledgerKind,
  monthShare,
  orderStats,
  reconTotals,
  shareOf,
  sortByCredits,
} from "../billing-display";

describe("billingTab:地址里的 ?tab= → 页签", () => {
  it.each([
    ["packages", "packages"],
    ["ledger", "ledger"],
    ["runs", "runs"],
    // 原型里的锚点叫 cost
    ["cost", "runs"],
    ["overview", "overview"],
    ["", "overview"],
    [null, "overview"],
    ["nope", "overview"],
  ])("%s → %s", (raw, tab) => {
    expect(billingTab(raw)).toBe(tab);
  });
});

const entry = (kind: "credit" | "reserve" | "settle" | "refund", amount: string) => ({
  kind,
  amountMicroCredits: amount,
});

describe("ledgerKind:流水类型、正负与色调", () => {
  it("入账与多扣退还是加项", () => {
    expect(ledgerKind(entry("credit", "5"))).toEqual({
      label: "人工入账",
      sign: "+",
      tone: "success",
    });
    expect(ledgerKind(entry("refund", "5"))).toEqual({
      label: "多扣退还",
      sign: "+",
      tone: "success",
    });
  });
  it("冻结是减项、提醒色", () => {
    expect(ledgerKind(entry("reserve", "5"))).toEqual({
      label: "冻结",
      sign: "-",
      tone: "warning",
    });
  });
  it("结算为减项;结算 0 是释放冻结", () => {
    expect(ledgerKind(entry("settle", "5"))).toEqual({ label: "结算", sign: "-", tone: "default" });
    expect(ledgerKind(entry("settle", "0"))).toEqual({
      label: "释放冻结",
      sign: "",
      tone: "outline",
    });
  });
});

describe("monthShare:本月已用占月度上限", () => {
  it("没有上限 = null", () => {
    expect(monthShare({ usedMicroCredits: "5", limitMicroCredits: null })).toBeNull();
    expect(monthShare(undefined)).toBeNull();
  });
  it("按比例取整、封顶 100", () => {
    expect(monthShare({ usedMicroCredits: "37", limitMicroCredits: "100" })).toBe(37);
    expect(monthShare({ usedMicroCredits: "300", limitMicroCredits: "100" })).toBe(100);
    expect(monthShare({ usedMicroCredits: "0", limitMicroCredits: "0" })).toBe(100);
  });
});

const charge = (over: Partial<Parameters<typeof chargeStatus>[0]>) => ({
  state: "settled" as const,
  owedMicro: null,
  refundedMicro: null,
  incomplete: false,
  ...over,
});

describe("chargeStatus:一次运行的扣费状态", () => {
  it("冻结中", () => {
    expect(chargeStatus(charge({ state: "open" }))).toMatchObject({
      label: "冻结中",
      tone: "warning",
    });
  });
  it("已结算 / 多扣已退还", () => {
    expect(chargeStatus(charge({}))).toMatchObject({ label: "已结算", tone: "success", note: "" });
    expect(chargeStatus(charge({ refundedMicro: "2000000" }))).toMatchObject({
      label: "多扣已退还",
      tone: "success",
    });
  });
  it("暂记欠额:充值后自动补扣", () => {
    const s = chargeStatus(charge({ state: "provisional", owedMicro: "3400000" }));
    expect(s).toMatchObject({ label: "欠额", tone: "destructive" });
    expect(s.note).toContain("充值后自动补扣");
  });
  it("暂记无欠额 = 待核对", () => {
    expect(chargeStatus(charge({ state: "provisional" }))).toMatchObject({ label: "待核对" });
  });
  it("已结算但用量不完整或补扣不足 = 待核对", () => {
    expect(chargeStatus(charge({ incomplete: true })).label).toBe("待核对");
    expect(chargeStatus(charge({ owedMicro: "1" })).label).toBe("待核对");
  });
});

describe("shareOf:条形宽度", () => {
  it("占最大值的百分比,有值至少 2%", () => {
    expect(shareOf("50", "200")).toBe(25);
    expect(shareOf("1", "1000")).toBe(2);
    expect(shareOf("0", "1000")).toBe(0);
    expect(shareOf("5", "0")).toBe(0);
  });
});

describe("sortByCredits:积分包按积分数从少到多", () => {
  it("按数值而不是 id 字符串排序", () => {
    const list = [
      { id: "b", creditsMicro: "10500000000" },
      { id: "a", creditsMicro: "1000000000" },
      { id: "c", creditsMicro: "3090000000" },
      { id: "d", creditsMicro: "32400000000" },
    ];
    expect(sortByCredits(list).map((p) => p.id)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("orderStats:订单页签顶部四张统计卡", () => {
  const NOW = new Date(2026, 10, 13, 12).getTime();
  const lastMonth = new Date(2026, 9, 30).getTime();
  const o = (
    status: string,
    creditsMicro: string,
    priceMinor: string,
    currency: string,
    creditedAt?: number,
  ) => ({
    status: status as "pending" | "credited" | "cancelled",
    creditsMicro,
    priceMinor,
    currency: currency as "CNY" | "USD",
    creditedAt,
  });
  it("待处理数、本月已发放积分、本月按币种的收款(只算本月确认的)", () => {
    const s = orderStats(
      [
        o("pending", "1000000000", "1000", "CNY"),
        o("pending", "1000000000", "1000", "CNY"),
        o("credited", "5000000000", "4800", "CNY", NOW - 1000),
        o("credited", "20000000000", "18000", "CNY", NOW - 2000),
        o("credited", "1000000000", "1500", "USD", NOW - 3000),
        o("credited", "9000000000", "9000", "CNY", lastMonth),
        o("cancelled", "1000000000", "1000", "CNY"),
      ],
      NOW,
    );
    expect(s).toEqual({
      pending: 2,
      creditedMicro: "26000000000",
      cnyMinor: "22800",
      usdMinor: "1500",
    });
  });
});

describe("countEmails:批量发放实时显示已识别的邮箱数", () => {
  it("按换行、逗号、分号和空白拆分,空的不算", () => {
    expect(countEmails("a@x.cn\nb@x.cn, c@x.cn；d@x.cn  \n\n")).toBe(4);
    expect(countEmails("   ")).toBe(0);
  });
});

describe("batchSummary:批量发放预览汇总", () => {
  it("可发放人数、跳过人数、合计积分", () => {
    const lines = [
      { email: "a@x.cn", status: "ready" as const, accountId: "a" },
      { email: "b@x.cn", status: "ready" as const, accountId: "b" },
      { email: "c@x.cn", status: "not_found" as const },
      { email: "a@x.cn", status: "duplicate" as const },
    ];
    expect(batchSummary(lines, "8.8")).toEqual({ ready: 2, skipped: 2, totalMicro: "17600000" });
  });
  it("积分填错时合计为 null", () => {
    expect(batchSummary([], "abc").totalMicro).toBeNull();
  });
});

describe("creditsToYuan:1 元 = 100 积分", () => {
  it("整元不带小数,带千分位;不足一分舍去", () => {
    expect(creditsToYuan("386000000000")).toBe("3,860");
    expect(creditsToYuan("150000000")).toBe("1.50");
    expect(creditsToYuan("999999")).toBe("0");
  });
});

describe("reconTotals:对账表的合计行", () => {
  const line = (runs: number, complete: number, cost: string, est: string, charged: string) => ({
    runs,
    counts: { complete } as Record<string, number>,
    tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
    costMicro: cost,
    estimatedMicro: est,
    chargedMicro: charged,
  });
  it("各列相加,不完整数据 = 运行数 - 完整数", () => {
    expect(reconTotals([line(5, 4, "100", "200", "190"), line(3, 3, "50", "80", "80")])).toEqual({
      runs: 8,
      incomplete: 1,
      tokens: { input: 20, output: 4, cacheRead: 2, cacheWrite: 0 },
      costMicro: "150",
      estimatedMicro: "280",
      chargedMicro: "270",
    });
  });
});
