import { workspacePathOf } from "@/components/ai-elements/workspace-link";
import { pickerNote, sessionWaitOf } from "@/features/workbench/chat-view.logic";
import { summarizeToolInput } from "@/features/workbench/conversation";
import type { FileNode, SessionSummary, Turn } from "@/features/workbench/types";
import {
  answeredOptions,
  branchLabel,
  errorSummary,
  formatDuration,
  isFreshFile,
  latestPreviewable,
  missingRequired,
  recordToolTime,
  rerunEstimateMicro,
  shouldNotifyQuestion,
  stopConfirmBody,
  submitGate,
  variableUpdates,
} from "@/features/workbench/workbench.logic";
import { countWaits } from "@/lib/modules/approval/domain/wait-counts";
import { describe, expect, it } from "vitest";

describe("F1 对话里指向工作区文件的链接", () => {
  it("裸相对路径与 ./ 开头的都算工作区文件,解码并规范化", () => {
    expect(workspacePathOf("初审结果.md")).toBe("初审结果.md");
    expect(workspacePathOf("./out/a%20b.html")).toBe("out/a b.html");
    expect(workspacePathOf("out/./x/../y.md#sec")).toBe("out/y.md");
  });
  it("外链、站内绝对路径、锚点、越出根目录的不算", () => {
    expect(workspacePathOf("https://example.com/a.md")).toBeNull();
    expect(workspacePathOf("mailto:a@b.c")).toBeNull();
    expect(workspacePathOf("javascript:alert(1)")).toBeNull();
    expect(workspacePathOf("//cdn.example.com/x")).toBeNull();
    expect(workspacePathOf("/chat")).toBeNull();
    expect(workspacePathOf("#top")).toBeNull();
    expect(workspacePathOf("../secret")).toBeNull();
    expect(workspacePathOf("")).toBeNull();
    expect(workspacePathOf(undefined)).toBeNull();
  });
});

describe("F2 提问通知", () => {
  it("窄屏一律不弹", () => {
    expect(shouldNotifyQuestion({ narrow: true, pageVisible: false, cardInView: false })).toBe(
      false,
    );
  });
  it("卡片就在眼前且页面可见时不弹;看不到卡片或页面在后台才弹", () => {
    expect(shouldNotifyQuestion({ narrow: false, pageVisible: true, cardInView: true })).toBe(
      false,
    );
    expect(shouldNotifyQuestion({ narrow: false, pageVisible: true, cardInView: false })).toBe(
      true,
    );
    expect(shouldNotifyQuestion({ narrow: false, pageVisible: false, cardInView: true })).toBe(
      true,
    );
  });
});

describe("F3 停止确认", () => {
  it("说明文件保留;有排队时写上条数", () => {
    expect(stopConfirmBody(0)).toBe("智能体会在当前步骤结束后停下，已生成的文件保留在工作区。");
    expect(stopConfirmBody(2)).toBe(
      "智能体会在当前步骤结束后停下，已生成的文件保留在工作区。排队中的 2 条消息不会发送。",
    );
  });
});

describe("F4 等审批 / 等回答时发消息", () => {
  it("等回答时拦下,等确认时排队,其余照旧追加", () => {
    expect(submitGate({ approvals: 0, questions: 1 })).toBe("block");
    expect(submitGate({ approvals: 1, questions: 1 })).toBe("block");
    expect(submitGate({ approvals: 2, questions: 0 })).toBe("queue");
    expect(submitGate({ approvals: 0, questions: 0 })).toBe("steer");
  });
});

describe("F5 必填变量与错误摘要", () => {
  const defs = [
    { name: "ERP_TOKEN", required: true, secret: true },
    { name: "DEPT", required: true },
    { name: "NOTE" },
  ];
  it("列出没填的必填变量", () => {
    expect(missingRequired(defs, { DEPT: "财务" })).toEqual(["ERP_TOKEN"]);
    expect(missingRequired(defs, { ERP_TOKEN: "***", DEPT: " " })).toEqual(["DEPT"]);
    expect(missingRequired(defs, { ERP_TOKEN: "***", DEPT: "x" })).toEqual([]);
  });
  it("错误摘要不带 Error: 前缀", () => {
    expect(errorSummary(new Error("发起运行失败:积分不足"))).toBe("发起运行失败:积分不足");
    expect(errorSummary(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
    expect(errorSummary("x")).toBe("x");
  });
});

describe("F27 变量保存", () => {
  const defs = [
    { name: "ERP_TOKEN", required: true, secret: true },
    { name: "DEPT", required: true },
  ];
  it("已保存的密钥留空 = 不修改(不发送);填了才更新;普通变量照常", () => {
    expect(
      variableUpdates(defs, { ERP_TOKEN: "***", DEPT: "a" }, { ERP_TOKEN: "", DEPT: "b" }),
    ).toEqual({ DEPT: "b" });
    expect(
      variableUpdates(defs, { ERP_TOKEN: "***" }, { ERP_TOKEN: "new-token", DEPT: "" }),
    ).toEqual({ ERP_TOKEN: "new-token", DEPT: "" });
  });
});

describe("F9 / F24 工作区文件", () => {
  const nodes: FileNode[] = [
    { path: "a.md", name: "a.md", type: "file", mtime: 100 },
    { path: "b.html", name: "b.html", type: "file", mtime: 300 },
    { path: "c.py", name: "c.py", type: "file", mtime: 500 },
    { path: "d", name: "d", type: "dir", mtime: 900 },
  ];
  it("按修改时间选最新的 md 或 html", () => {
    expect(latestPreviewable(nodes)).toBe("b.html");
    expect(latestPreviewable([{ path: "x.py", name: "x.py", type: "file" }])).toBeNull();
  });
  it("最近一轮开始之后改过的文件标「新」", () => {
    expect(isFreshFile({ path: "a", name: "a", type: "file", mtime: 2000 }, 1000)).toBe(true);
    expect(isFreshFile({ path: "a", name: "a", type: "file", mtime: 500 }, 1000)).toBe(false);
    expect(isFreshFile({ path: "a", name: "a", type: "file", mtime: 2000 }, undefined)).toBe(false);
    expect(isFreshFile({ path: "d", name: "d", type: "dir", mtime: 2000 }, 1000)).toBe(false);
  });
});

describe("F7 会话列表的等待标签", () => {
  const base: SessionSummary = { id: "s1", agentId: "a", workspaceDir: "", createdAt: 0 };
  it("列表接口带回的计数:待确认优先", () => {
    expect(sessionWaitOf({ ...base, pendingApprovals: 1, pendingQuestions: 1 }, null)).toBe(
      "approval",
    );
    expect(sessionWaitOf({ ...base, pendingQuestions: 2 }, null)).toBe("ask");
    expect(sessionWaitOf(base, null)).toBeNull();
  });
  it("当前打开的会话以实时轮询为准", () => {
    expect(
      sessionWaitOf({ ...base, pendingApprovals: 1 }, { id: "s1", running: true, wait: null }),
    ).toBeNull();
    expect(sessionWaitOf(base, { id: "s1", running: true, wait: "ask" })).toBe("ask");
    expect(sessionWaitOf(base, { id: "s1", running: false, wait: "ask" })).toBe("ask");
    expect(
      sessionWaitOf({ ...base, pendingQuestions: 1 }, { id: "s2", running: true, wait: null }),
    ).toBe("ask");
  });
  it("服务端按待审列表数出审批与提问", () => {
    expect(
      countWaits([{ questions: [{ question: "q", options: [] }] }, { questions: [] }, {}]),
    ).toEqual({ approvals: 2, questions: 1 });
  });
});

describe("F11 工具调用摘要与耗时", () => {
  it("没有说明字段时取第一个字符串参数值,截到 60 字", () => {
    expect(summarizeToolInput("erp_lookup", { dept: "财务部", month: 11 })).toBe("财务部");
    expect(summarizeToolInput("x", { n: 1, query: "a".repeat(80) })).toBe(`${"a".repeat(60)}…`);
    expect(summarizeToolInput("x", { description: "确认审批人规则", q: "z" })).toBe(
      "确认审批人规则",
    );
    expect(summarizeToolInput("x", { list: [1], n: 2 })).toBe("list, n");
  });
  it("记录工具调用的起止(按 toolUseId),算出耗时", () => {
    let times = recordToolTime(
      undefined,
      { kind: "tool_use", tool: "Bash", input: {}, toolUseId: "t1" },
      1000,
    );
    times = recordToolTime(times, { kind: "text", text: "x" }, 1200);
    times = recordToolTime(times, { kind: "tool_result", toolUseId: "t1", text: "ok" }, 2600);
    expect(times).toEqual({ t1: { start: 1000, end: 2600 } });
    expect(recordToolTime(times, { kind: "text", text: "y" }, 3000)).toBe(times);
  });
  it("耗时格式", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(1600)).toBe("1.6s");
    expect(formatDuration(12_300)).toBe("12s");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });
});

describe("F21 分叉标记", () => {
  const turns: Turn[] = [
    { prompt: "a", events: [], running: false, runId: "r1" },
    { prompt: "b", events: [], running: false, runId: "r2" },
  ];
  it("写明从第几轮之后分叉", () => {
    expect(branchLabel(turns, "r2")).toBe("从第 1 轮之后分叉重跑");
    expect(branchLabel(turns, "r1")).toBe("从会话开头分叉重跑");
    expect(branchLabel(turns, "gone")).toBe("从上文某轮分叉重跑");
  });
});

describe("F22 重跑花费预估", () => {
  const rates = [
    { meter: "input_token" as const, units: "1000000", microCredits: "3000000" },
    { meter: "output_token" as const, units: "1000000", microCredits: "15000000" },
  ];
  it("按这一轮的 token 用量与当前单价估算(微积分)", () => {
    expect(rerunEstimateMicro(rates, { input: 1_000_000, output: 100_000 })).toBe(4_500_000n);
    expect(rerunEstimateMicro(rates, { input: 0, output: 0 })).toBeNull();
    expect(rerunEstimateMicro([], { input: 10, output: 10 })).toBeNull();
  });
});

describe("F23 已回答的提问", () => {
  it("回答里与选项同名的部分标成选中,其余算自己填写", () => {
    const options = [{ label: "开票日" }, { label: "入账日" }];
    expect(answeredOptions(options, "开票日")).toEqual({ picked: ["开票日"], other: "" });
    expect(answeredOptions(options, "开票日、按月末")).toEqual({
      picked: ["开票日"],
      other: "按月末",
    });
    expect(answeredOptions(options, null)).toEqual({ picked: [], other: "" });
  });
});

describe("F15 新会话弹层的说明", () => {
  const base = { id: "a", name: "A", config: {}, publishedVersion: 2 };
  it("分享来的写明只读或可编辑,市场的写明来源与平均花费", () => {
    expect(pickerNote({ ...base, canWrite: false }, "分享给我")).toBe("只读，跑已发布 v2");
    expect(pickerNote({ ...base, canWrite: true }, "分享给我")).toContain("可编辑，跑草稿");
    // 原型:「由 X 分享」—— 分享人取所有者邮箱前缀
    expect(pickerNote({ ...base, canWrite: false, ownerName: "luojing" }, "分享给我")).toBe(
      "luojing 分享，只读，跑已发布 v2",
    );
    expect(
      pickerNote({ ...base, canWrite: false, isPublic: true, ownerName: "luojing" }, "分享给我"),
    ).toBe("luojing 公开，只读，跑已发布 v2");
    expect(pickerNote({ ...base, canRead: false, avgCredits: 12 } as never, "市场")).toBe(
      "市场，跑已发布 v2，平均每次约 12 积分",
    );
    expect(pickerNote({ ...base, canRead: false }, "市场")).toBe("市场，跑已发布 v2");
  });
});
