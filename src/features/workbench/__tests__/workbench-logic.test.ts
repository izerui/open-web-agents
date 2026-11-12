import type { SessionSummary, Turn } from "@/features/workbench/types";
import {
  filterSessionsForAgent,
  promptFromSearch,
  sessionIdFromSearch,
  updateTurnByLocalId,
  withSessionInUrl,
} from "@/features/workbench/workbench.logic";
import { describe, expect, it } from "vitest";

const session = (id: string, agentId: string, title?: string): SessionSummary => ({
  id,
  agentId,
  title,
  workspaceDir: `/workspaces/${id}`,
  createdAt: 1,
});

describe("promptFromSearch", () => {
  it("?q= 预填输入框;没有或只有空白时为 null", () => {
    expect(promptFromSearch("?session=s1&q=%E5%B8%AE%E6%88%91%E7%BF%BB%E8%AF%91")).toBe("帮我翻译");
    expect(promptFromSearch("?q=%20%20")).toBeNull();
    expect(promptFromSearch("?session=s1")).toBeNull();
  });

  it("保留原文里的换行与首尾以外的空白", () => {
    expect(promptFromSearch(`?q=${encodeURIComponent(" 第一行\n第二行 ")}`)).toBe("第一行\n第二行");
  });
});

describe("session URL", () => {
  it("读写当前会话参数时保留其它查询和 hash", () => {
    expect(sessionIdFromSearch("?view=chat&session=s-1")).toBe("s-1");
    expect(withSessionInUrl("https://owa.test/?view=chat#latest", "s-1")).toBe(
      "/?view=chat&session=s-1#latest",
    );
    expect(withSessionInUrl("https://owa.test/?view=chat&session=s-1", null)).toBe("/?view=chat");
  });

  it("空参数和异常地址安全回退", () => {
    expect(sessionIdFromSearch("?session=")).toBeNull();
    expect(withSessionInUrl("not a url", "s-1")).toBe("not a url");
  });
});

describe("filterSessionsForAgent", () => {
  const sessions = [
    session("s-a-1", "agent-a", "代码评审"),
    session("s-a-2", "agent-a", "周报"),
    session("s-b-1", "agent-b", "代码评审"),
  ];

  it("只显示当前智能体的会话，避免标题与实际运行智能体错配", () => {
    expect(filterSessionsForAgent(sessions, "agent-a", "").map((item) => item.id)).toEqual([
      "s-a-1",
      "s-a-2",
    ]);
  });

  it("搜索只在当前智能体的会话内进行", () => {
    expect(filterSessionsForAgent(sessions, "agent-b", "代码").map((item) => item.id)).toEqual([
      "s-b-1",
    ]);
    expect(filterSessionsForAgent(sessions, "agent-b", "周报")).toEqual([]);
  });
});

describe("updateTurnByLocalId", () => {
  it("runId 返回前后都只更新原来的乐观轮次", () => {
    const turns: Turn[] = [
      { localId: "local-a", prompt: "旧轮次", events: [], running: true },
      { localId: "local-b", prompt: "新轮次", events: [], running: true },
    ];
    const updated = updateTurnByLocalId(turns, "local-a", (turn) => ({
      ...turn,
      runId: "run-a",
      running: false,
    }));

    expect(updated[0]).toMatchObject({ localId: "local-a", runId: "run-a", running: false });
    expect(updated[1]).toBe(turns[1]);
  });

  it("目标轮次已经因切换会话卸载时不污染当前列表", () => {
    const current: Turn[] = [
      { localId: "local-new", prompt: "另一个会话", events: [], running: true },
    ];
    expect(
      updateTurnByLocalId(current, "local-old", (turn) => ({ ...turn, running: false })),
    ).toEqual(current);
  });
});
