import { describe, expect, it } from "vitest";
import {
  PALETTE_AGENT_LIMIT,
  agentStatusText,
  paletteAgents,
  sessionMeta,
  sessionTitle,
} from "../palette-logic";

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

  it("内置的写「内置」,别人分享来的写「分享」(公开的写「公开」),不一律叫草稿", () => {
    expect(agentStatusText({ id: "default", isOwner: true, publishedVersion: null })).toBe("内置");
    expect(agentStatusText({ id: "agent-architect", publishedVersion: 2 })).toBe("内置");
    expect(agentStatusText({ id: "x", isOwner: false, publishedVersion: null })).toBe("分享");
    expect(agentStatusText({ id: "x", isOwner: false, publishedVersion: 4 })).toBe("分享");
    expect(agentStatusText({ id: "x", isOwner: false, isPublic: true })).toBe("公开");
    // 自己的照旧
    expect(agentStatusText({ id: "x", isOwner: true, publishedVersion: null })).toBe("草稿");
  });
});

describe("⌘K 智能体组的条数", () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}` }));
  it("没输入时只列前 8 条,并提示还有更多", () => {
    expect(PALETTE_AGENT_LIMIT).toBe(8);
    const r = paletteAgents(list, "");
    expect(r.shown.map((a) => a.id)).toEqual(list.slice(0, 8).map((a) => a.id));
    expect(r.more).toBe(true);
  });
  it("输入了搜索词时全部交给面板过滤,不截断", () => {
    const r = paletteAgents(list, "a1");
    expect(r.shown).toHaveLength(20);
    expect(r.more).toBe(false);
  });
  it("不够 8 条时没有「查看全部」", () => {
    expect(paletteAgents(list.slice(0, 5), "").more).toBe(false);
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
