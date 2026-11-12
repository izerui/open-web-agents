import { describe, expect, it } from "vitest";
import { shortTime } from "../time-format";

// 本地时间 2026-11-12 14:30
const NOW = new Date(2026, 10, 12, 14, 30).getTime();
const at = (y: number, mo: number, d: number, h = 9, mi = 5) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("shortTime:列表里的时间", () => {
  it("今天只显示时分", () => {
    expect(shortTime(at(2026, 11, 12, 9, 5), NOW)).toBe("09:05");
  });
  it("昨天", () => {
    expect(shortTime(at(2026, 11, 11, 18, 22), NOW)).toBe("昨天 18:22");
  });
  it("今年更早:月-日 时:分", () => {
    expect(shortTime(at(2026, 10, 2, 9, 14), NOW)).toBe("10-02 09:14");
  });
  it("往年:年-月-日", () => {
    expect(shortTime(at(2025, 12, 31), NOW)).toBe("2025-12-31");
  });
  it("跨年的昨天仍是昨天", () => {
    const jan1 = new Date(2027, 0, 1, 8).getTime();
    expect(shortTime(at(2026, 12, 31, 23, 50), jan1)).toBe("昨天 23:50");
  });
});
