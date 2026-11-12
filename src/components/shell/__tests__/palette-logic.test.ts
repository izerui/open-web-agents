import { describe, expect, it } from "vitest";
import { agentStatusText, sessionMeta, sessionTitle } from "../palette-logic";

describe("⌘K 智能体右侧的发布状态", () => {
  it("已发布 / 有改动未发布 / 草稿", () => {
    expect(agentStatusText({ publishedVersion: 3, hasUnpublishedChanges: false })).toBe(
      "已发布 v3",
    );
    expect(agentStatusText({ publishedVersion: 3, hasUnpublishedChanges: true })).toBe(
      "v3 · 有改动未发布",
    );
    expect(agentStatusText({ publishedVersion: null })).toBe("草稿");
    expect(agentStatusText({})).toBe("草稿");
  });
});

describe("⌘K 会话标题", () => {
  const now = new Date(2026, 10, 13, 12, 0).getTime();
  it("有标题用标题", () => {
    expect(sessionTitle({ title: " 周报 ", createdAt: now }, now)).toBe("周报");
  });
  it("没标题时用「新对话 · 时间」兜底,不显示 ID", () => {
    const at = new Date(2026, 10, 12, 9, 5).getTime();
    expect(sessionTitle({ title: "", createdAt: at }, now)).toBe("新对话 · 11-12 09:05");
    expect(sessionTitle({ createdAt: at }, now)).toBe("新对话 · 11-12 09:05");
  });
  it("连创建时间都没有时只写新对话", () => {
    expect(sessionTitle({}, now)).toBe("新对话");
  });
});

describe("⌘K 会话右侧", () => {
  it("显示轮数", () => {
    expect(sessionMeta({ runCount: 4 })).toBe("4 轮");
  });
  it("还没跑过显示「还没开始」", () => {
    expect(sessionMeta({ runCount: 0 })).toBe("还没开始");
    expect(sessionMeta({})).toBe("还没开始");
  });
});
