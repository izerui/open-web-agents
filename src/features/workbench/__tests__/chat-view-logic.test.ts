import {
  agentGroupOf,
  agentPageHref,
  chatBuckets,
  filterSessions,
  groupPickerAgents,
  rowTime,
  runTargetLabel,
  splitPromptAttachments,
  versionBadge,
} from "@/features/workbench/chat-view.logic";
import type { AgentSummary, SessionSummary } from "@/features/workbench/types";
import { describe, expect, it } from "vitest";

/** 2026-11-12 14:00 本地时间 */
const NOW = new Date(2026, 10, 12, 14, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function session(id: string, at: number, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, agentId: "a", workspaceDir: `/ws/${id}`, createdAt: at, ...over };
}

function agent(id: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return { id, name: id, config: {}, ...over };
}

describe("chatBuckets", () => {
  it("只分今天 / 昨天 / 更早,空组不出现,组内按最近活动倒序", () => {
    const groups = chatBuckets(
      [
        session("today-old", NOW - 3 * HOUR),
        session("today-new", NOW - HOUR),
        // 凌晨看昨天 23 点:差几小时也是「昨天」
        session("yesterday", new Date(2026, 10, 11, 23, 0).getTime()),
        session("week", NOW - 5 * DAY),
        session("month", NOW - 40 * DAY),
      ],
      NOW,
    );
    expect(groups.map((g) => g.bucket)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["today-new", "today-old"]);
    expect(groups[2]?.sessions.map((s) => s.id)).toEqual(["week", "month"]);
  });

  it("按最后活动时间而不是创建时间分组", () => {
    const groups = chatBuckets([session("s", NOW - 9 * DAY, { lastActiveAt: NOW - HOUR })], NOW);
    expect(groups.map((g) => g.bucket)).toEqual(["今天"]);
  });

  it("没有会话时返回空数组", () => {
    expect(chatBuckets([], NOW)).toEqual([]);
  });
});

describe("rowTime", () => {
  it("今天显示时分,昨天显示「昨天」,更早显示月-日", () => {
    expect(rowTime(new Date(2026, 10, 12, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(rowTime(new Date(2026, 10, 11, 9, 5).getTime(), NOW)).toBe("昨天");
    expect(rowTime(new Date(2026, 10, 7, 9, 5).getTime(), NOW)).toBe("11-07");
  });
});

describe("filterSessions", () => {
  const names = new Map([
    ["a", "报销审核助手"],
    ["b", "SQL 助手"],
  ]);
  const list = [
    session("s1", NOW, { title: "外币发票怎么换算", agentId: "a" }),
    session("s2", NOW, { title: "上月报销总额", agentId: "b" }),
    session("abcdef123", NOW, { agentId: "b" }),
  ];

  it("空查询原样返回", () => {
    expect(filterSessions(list, names, "  ")).toHaveLength(3);
  });

  it("按会话标题、智能体名搜索,忽略大小写", () => {
    expect(filterSessions(list, names, "发票").map((s) => s.id)).toEqual(["s1"]);
    expect(filterSessions(list, names, "sql").map((s) => s.id)).toEqual(["s2", "abcdef123"]);
  });

  it("没有标题的会话按显示出来的「新对话」也能搜到(不再显示 id)", () => {
    expect(filterSessions(list, names, "新对话").map((s) => s.id)).toEqual(["abcdef123"]);
  });
});

describe("versionBadge", () => {
  const draftAgent = agent("a", { canWrite: true, publishedVersion: 3 });
  const readAgent = agent("a", { canWrite: false, publishedVersion: 4 });

  it("运行中优先", () => {
    expect(versionBadge({ running: true, agent: draftAgent }).label).toBe("运行中");
  });

  it("会话锁定了版本:vN 锁定", () => {
    const b = versionBadge({ running: false, session: session("s", NOW, { agentVersion: 5 }) });
    expect(b).toMatchObject({ label: "v5 锁定", tone: "outline" });
  });

  it("还没有会话、没有编辑权限、已发布:已发布 vN", () => {
    expect(versionBadge({ running: false, agent: readAgent })).toMatchObject({
      label: "已发布 v4",
      tone: "success",
    });
  });

  it("能编辑的人、或从未发布、或跟随草稿的会话:草稿", () => {
    expect(versionBadge({ running: false, agent: draftAgent }).label).toBe("草稿");
    expect(versionBadge({ running: false, agent: agent("x") }).label).toBe("草稿");
    expect(
      versionBadge({ running: false, session: session("s", NOW), agent: readAgent }).label,
    ).toBe("草稿");
  });
});

describe("agentGroupOf / runTargetLabel / groupPickerAgents", () => {
  it("内置 / 我的 / 分享给我 / 市场", () => {
    expect(agentGroupOf(agent("default", { ownerId: "system" }), "u1")).toBe("内置");
    expect(agentGroupOf(agent("mine", { ownerId: "u1", canWrite: true }), "u1")).toBe("我的");
    expect(agentGroupOf(agent("shared", { ownerId: "u2", canWrite: false }), "u1")).toBe(
      "分享给我",
    );
    expect(agentGroupOf(agent("market", { canRead: false, publishedVersion: 2 }), "u1")).toBe(
      "市场",
    );
  });

  it("关闭登录的本地模式没有用户 id:能编辑的算「我的」", () => {
    expect(agentGroupOf(agent("local", { ownerId: "anon", canWrite: true }), null)).toBe("我的");
  });

  it("说明跑草稿还是已发布版本", () => {
    expect(runTargetLabel(agent("a", { canWrite: true, publishedVersion: 3 }))).toBe(
      "跑草稿，你有编辑权限（已发布 v3）",
    );
    expect(
      runTargetLabel(
        agent("a", { canWrite: true, publishedVersion: 3, hasUnpublishedChanges: true }),
      ),
    ).toBe("跑草稿，你有编辑权限（已发布 v3，草稿有未发布的修改）");
    expect(runTargetLabel(agent("a", { canWrite: true }))).toBe("跑草稿，还没有发布过");
    expect(runTargetLabel(agent("a", { canWrite: false, publishedVersion: 6 }))).toBe(
      "跑已发布 v6",
    );
    expect(runTargetLabel(agent("a", { canWrite: false }))).toBe("跑草稿，还没有发布过");
  });

  it("分组顺序固定,空组不出现", () => {
    const groups = groupPickerAgents(
      [
        agent("default", { ownerId: "system" }),
        agent("m", { canRead: false }),
        agent("mine", { ownerId: "u1", canWrite: true }),
      ],
      "u1",
    );
    expect(groups.map((g) => g.group)).toEqual(["我的", "市场", "内置"]);
  });
});

describe("跳转地址", () => {
  it("智能体名:自己能编辑的去构建页,其他去市场详情", () => {
    expect(agentPageHref(agent("a b", { canWrite: true }))).toBe("/agents/a%20b");
    expect(agentPageHref(agent("a", { canWrite: false }))).toBe("/market/a");
  });
});

describe("splitPromptAttachments", () => {
  it("把发送时拼在末尾的附件清单拆出来", () => {
    expect(
      splitPromptAttachments("看看这两份\n\n已上传到当前工作区的附件:\n- a.xlsx\n- dir/b.pdf"),
    ).toEqual({ text: "看看这两份", files: ["a.xlsx", "dir/b.pdf"] });
  });

  it("没有附件清单时原样返回", () => {
    expect(splitPromptAttachments("你好")).toEqual({ text: "你好", files: [] });
  });
});
