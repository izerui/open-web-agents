import { describe, expect, it } from "vitest";
import { ORDERS_HREF, meAccountRows, pendingOrdersHint, recentRunsHint } from "../me-logic";

describe("「我的」页入口", () => {
  it("我的订单直达订单列表,不是积分包列表", () => {
    expect(ORDERS_HREF).toBe("/account/billing?tab=packages&view=orders");
    expect(meAccountRows(false).find((r) => r.label === "我的订单")?.href).toBe(ORDERS_HREF);
  });

  it("登录账号六个入口", () => {
    expect(meAccountRows(false).map((r) => r.label)).toEqual([
      "我的订单",
      "积分流水",
      "用量",
      "模型价格",
      "账号安全",
      "操作日志",
    ]);
  });

  it("本地模式没有积分账户和密码:去掉订单、流水、账号安全", () => {
    expect(meAccountRows(true).map((r) => r.label)).toEqual(["用量", "模型价格", "操作日志"]);
  });
});

describe("入口右侧的附加信息", () => {
  it("待处理订单数", () => {
    expect(
      pendingOrdersHint([{ status: "pending" }, { status: "credited" }, { status: "pending" }]),
    ).toBe("2 个待处理");
    expect(pendingOrdersHint([{ status: "credited" }, { status: "cancelled" }])).toBe("");
    expect(pendingOrdersHint([])).toBe("");
  });

  it("近 7 天运行数,带千分位;记录被截断时加「+」;没有运行不写", () => {
    expect(recentRunsHint({ runs: 286 })).toBe("近 7 天 286 次");
    expect(recentRunsHint({ runs: 12480 })).toBe("近 7 天 12,480 次");
    expect(recentRunsHint({ runs: 500 }, true)).toBe("近 7 天 500+ 次");
    expect(recentRunsHint({ runs: 0 })).toBe("");
    expect(recentRunsHint(undefined)).toBe("");
  });
});
