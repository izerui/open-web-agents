import { describe, expect, it } from "vitest";
import { orderMatches, shortOrderId } from "../order-number";

const ID = "be162900-1f2e-4c3d-9a8b-7c6d5e4f3a21";

describe("shortOrderId:用户侧与管理端同一种订单短号", () => {
  it("取前 8 位大写", () => {
    expect(shortOrderId(ID)).toBe("BE162900");
    expect(shortOrderId("abc")).toBe("ABC");
  });
});

describe("orderMatches:管理端订单搜索", () => {
  const order = {
    id: ID,
    accountEmail: "Someone@Example.test",
    accountId: "u-1",
    packageName: "标准包",
  };
  it("空搜索匹配全部", () => {
    expect(orderMatches(order, "")).toBe(true);
    expect(orderMatches(order, "   ")).toBe(true);
  });
  it("短号大小写都认,也认带 # 或空格", () => {
    expect(orderMatches(order, "BE162900")).toBe(true);
    expect(orderMatches(order, "be162900")).toBe(true);
    expect(orderMatches(order, " #BE16 ")).toBe(true);
  });
  it("完整编号、邮箱、套餐名也能搜", () => {
    expect(orderMatches(order, ID)).toBe(true);
    expect(orderMatches(order, ID.toUpperCase())).toBe(true);
    expect(orderMatches(order, "someone@")).toBe(true);
    expect(orderMatches(order, "标准")).toBe(true);
  });
  it("不相关的不匹配", () => {
    expect(orderMatches(order, "DEADBEEF")).toBe(false);
    expect(orderMatches({ ...order, accountEmail: undefined }, "someone")).toBe(false);
  });
});
