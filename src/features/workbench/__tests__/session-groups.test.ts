import { bucketOf, groupSessions, relativeTime } from "@/features/workbench/session-groups";
import type { SessionSummary } from "@/features/workbench/types";
import { describe, expect, it } from "vitest";

/** 2026-08-10 14:00 本地时间 —— 固定基准,免得测试跟着真实时间漂。 */
const NOW = new Date(2026, 7, 10, 14, 0, 0).getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function session(id: string, createdAt: number): SessionSummary {
  return { id, assistantId: "a", workspaceDir: `/tmp/${id}`, createdAt };
}

describe("relativeTime", () => {
  it("一分钟内算刚刚", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
  });

  it("时钟回拨导致的未来时间也算刚刚,不出现负数", () => {
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toBe("刚刚");
  });

  it("按分钟/小时/天逐级升档", () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toBe("5 分钟前");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 小时前");
    expect(relativeTime(NOW - 5 * DAY, NOW)).toBe("5 天前");
  });

  it("边界:59 分钟仍是分钟,60 分钟进位到小时", () => {
    expect(relativeTime(NOW - 59 * MINUTE, NOW)).toBe("59 分钟前");
    expect(relativeTime(NOW - 60 * MINUTE, NOW)).toBe("1 小时前");
  });

  it("超过 30 天改用具体日期", () => {
    const old = new Date(2026, 0, 3, 9, 0, 0).getTime();
    expect(relativeTime(old, NOW)).toBe("1月3日");
  });
});

describe("bucketOf", () => {
  it("同一日历日算今天", () => {
    expect(bucketOf(new Date(2026, 7, 10, 1, 0, 0).getTime(), NOW)).toBe("今天");
  });

  it("凌晨看昨晚的会话应归昨天,而不是按 24 小时算成今天", () => {
    const earlyMorning = new Date(2026, 7, 10, 1, 0, 0).getTime();
    const lastNight = new Date(2026, 7, 9, 23, 0, 0).getTime();
    // 只差两小时,但跨了日历日
    expect(bucketOf(lastNight, earlyMorning)).toBe("昨天");
  });

  it("七天内与更早分开", () => {
    expect(bucketOf(NOW - 5 * DAY, NOW)).toBe("最近 7 天");
    expect(bucketOf(NOW - 30 * DAY, NOW)).toBe("更早");
  });

  it("未来时间归今天,不掉进更早", () => {
    expect(bucketOf(NOW + 2 * HOUR, NOW)).toBe("今天");
  });
});

describe("groupSessions", () => {
  it("空组不出现,只返回有内容的档", () => {
    const groups = groupSessions([session("s1", NOW - 10 * MINUTE)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bucket).toBe("今天");
  });

  it("按固定顺序排档,组内新的在前", () => {
    const groups = groupSessions(
      [
        session("old", NOW - 20 * DAY),
        session("today-early", new Date(2026, 7, 10, 9, 0, 0).getTime()),
        session("yesterday", new Date(2026, 7, 9, 12, 0, 0).getTime()),
        session("today-late", new Date(2026, 7, 10, 13, 0, 0).getTime()),
      ],
      NOW,
    );

    expect(groups.map((g) => g.bucket)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["today-late", "today-early"]);
  });

  it("不丢会话", () => {
    const input = [
      session("a", NOW - 1 * MINUTE),
      session("b", NOW - 2 * DAY),
      session("c", NOW - 40 * DAY),
    ];
    const total = groupSessions(input, NOW).reduce((n, g) => n + g.sessions.length, 0);
    expect(total).toBe(input.length);
  });
});
