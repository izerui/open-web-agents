import { describe, expect, it } from "vitest";
import { formatTime } from "../format-time";

// 全站时间统一 MM-DD HH:mm(跨年加年份),不跟浏览器语言走 —— 英文浏览器里曾显示成 11/12/2026, 11:56 PM
describe("formatTime", () => {
  const now = new Date(2026, 10, 13, 9, 30).getTime();

  it("同一年:MM-DD HH:mm", () => {
    expect(formatTime(new Date(2026, 10, 10, 3, 5).getTime(), now)).toBe("11-10 03:05");
  });

  it("跨年:YYYY-MM-DD HH:mm", () => {
    expect(formatTime(new Date(2025, 0, 2, 14, 0).getTime(), now)).toBe("2025-01-02 14:00");
  });

  it("非法输入返回破折号,不抛错", () => {
    expect(formatTime(Number.NaN, now)).toBe("—");
  });
});
