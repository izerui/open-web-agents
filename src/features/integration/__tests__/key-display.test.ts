import { describe, expect, it } from "vitest";
import { accessStatusText, keyExpiry, monthlyShare, parseRpmDraft } from "../key-display";

const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);
const H = 3_600_000;

describe("keyExpiry:Key 的有效期标签", () => {
  it("没有到期时间 = 不过期", () => {
    expect(keyExpiry(undefined, NOW)).toEqual({ kind: "never", text: "不过期" });
  });
  it("已过到期时间 = 已过期", () => {
    expect(keyExpiry(NOW - 1, NOW)).toEqual({ kind: "expired", text: "已过期" });
    expect(keyExpiry(NOW, NOW).kind).toBe("expired");
  });
  it("48 小时内显示还剩几小时", () => {
    expect(keyExpiry(NOW + 36 * H, NOW)).toEqual({ kind: "soon", text: "36 小时后过期" });
    expect(keyExpiry(NOW + 10 * 60_000, NOW)).toEqual({ kind: "soon", text: "1 小时后过期" });
  });
  it("更远的显示到期日期", () => {
    const e = keyExpiry(NOW + 10 * 24 * H, NOW);
    expect(e.kind).toBe("date");
    expect(e.text).toMatch(/到期$/);
  });
});

describe("monthlyShare:本月积分用量占月度上限", () => {
  it("没有上限 = 不画进度条", () => {
    expect(monthlyShare("1000000", undefined)).toBeNull();
  });
  it("按比例取整", () => {
    expect(monthlyShare("50000000", "100000000")).toEqual({ pct: 50, high: false });
  });
  it("用到八成标为偏高", () => {
    expect(monthlyShare("85000000", "100000000")).toEqual({ pct: 85, high: true });
  });
  it("超过上限封顶 100;上限为 0 视为已满", () => {
    expect(monthlyShare("300000000", "100000000")).toEqual({ pct: 100, high: true });
    expect(monthlyShare("0", "0")).toEqual({ pct: 100, high: true });
  });
});

describe("parseRpmDraft:每分钟上限输入", () => {
  it.each(["", "  ", "0", "1.5", "abc", "-3"])("「%s」不合法", (raw) => {
    expect(parseRpmDraft(raw, 60).ok).toBe(false);
  });
  it("正整数合法", () => {
    expect(parseRpmDraft("30", 60)).toEqual({ ok: true, value: 30 });
    expect(parseRpmDraft(" 60 ", 60)).toEqual({ ok: true, value: 60 });
  });
  it("超过平台默认上限时提示范围", () => {
    const r = parseRpmDraft("61", 60);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("60");
  });
  it("平台不限(0)时只要求正整数", () => {
    expect(parseRpmDraft("5000", 0)).toEqual({ ok: true, value: 5000 });
  });
});

describe("accessStatusText:智能体对调用方的状态", () => {
  it("已发布", () => {
    expect(accessStatusText({ published: { version: 3 } })).toBe("已发布 v3");
  });
  it("已发布且草稿有改动", () => {
    expect(accessStatusText({ published: { version: 3 }, hasUnpublishedChanges: true })).toBe(
      "已发布 v3，草稿有未发布修改（不影响调用方）",
    );
  });
  it("从未发布", () => {
    expect(accessStatusText({ published: null })).toBe("未发布，调用使用草稿");
    expect(accessStatusText({})).toBe("未发布，调用使用草稿");
  });
});
