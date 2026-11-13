import { describe, expect, it } from "vitest";
import {
  copiedFrom,
  needsRecharge,
  nextStepFor,
  pendingAnchor,
  shouldAutoSend,
} from "../designer-model";

describe("shouldAutoSend:带描述进新建页时自动发给设计器(取舍 1)", () => {
  const base = {
    desc: "做一个报销审核助手",
    sessionId: "s1",
    loading: false,
    hasView: true,
    turnCount: 0,
    attempted: false,
    blocked: false,
  };
  it("会话已载入、还没有任何轮次:发", () => {
    expect(shouldAutoSend(base)).toBe(true);
  });
  it.each([
    [{ desc: "  " }],
    [{ desc: undefined }],
    [{ sessionId: "" }],
    [{ loading: true }],
    [{ hasView: false }],
    [{ turnCount: 1 }],
    [{ attempted: true }],
    [{ blocked: true }],
  ])("%j 时不发", (patch) => {
    expect(shouldAutoSend({ ...base, ...patch })).toBe(false);
  });
});

describe("pendingAnchor:待确认改动挂在哪一轮下面", () => {
  it("最后一轮已结束:挂最后一轮", () => {
    expect(pendingAnchor([{ running: false }, { running: false }])).toBe(1);
  });
  it("最后一轮还在跑:挂上一轮", () => {
    expect(pendingAnchor([{ running: false }, { running: true }])).toBe(0);
  });
  it("没有轮次:-1", () => {
    expect(pendingAnchor([])).toBe(-1);
    expect(pendingAnchor([{ running: true }])).toBe(-1);
  });
});

describe("nextStepFor:设计器底部的「下一步」提示(前端生成,不调模型)", () => {
  it("应用后:试聊一条 / 看评测用例", () => {
    const s = nextStepFor({ kind: "applied", sections: ["提示词", "输入输出契约"] });
    expect(s.text).toContain("「提示词」「输入输出契约」");
    expect(s.actions.map((a) => [a.label, a.to])).toEqual([
      ["试聊一条", "trial"],
      ["看评测用例", "eval"],
    ]);
  });
  it("存为用例后:去评测", () => {
    const s = nextStepFor({ kind: "caseSaved", count: 3 });
    expect(s.text).toContain("共 3 个");
    expect(s.actions).toEqual([{ label: "去评测", to: "eval" }]);
  });
  it("评测有失败:让设计器修复这 N 个", () => {
    const s = nextStepFor({ kind: "evalDone", passed: 4, total: 6 });
    expect(s.text).toContain("4/6");
    expect(s.actions[0]).toEqual({ label: "让设计器修复这 2 个", to: "fix" });
  });
  it("评测全过:打开上线清单", () => {
    const s = nextStepFor({ kind: "evalDone", passed: 6, total: 6 });
    expect(s.actions).toEqual([{ label: "打开上线清单", to: "publish" }]);
  });
  it("发布后:去接入", () => {
    const s = nextStepFor({ kind: "published", version: 4 });
    expect(s.text).toContain("v4 已发布");
    expect(s.actions).toEqual([{ label: "去接入", to: "access" }]);
  });
});

describe("needsRecharge:积分不足的报错带充值链接", () => {
  it.each([
    ["积分不足,请充值或联系管理员", true],
    ["可用积分不足", true],
    ["HTTP 500", false],
  ])("%s", (msg, want) => {
    expect(needsRecharge(msg)).toBe(want);
  });
});

describe("copiedFrom:复制进来的技能包 / MCP 来自哪个智能体(取舍 5)", () => {
  it("设计草稿里还引用着的资源按名字对上来源", () => {
    const ref = (id: string, kind: string, name: string) => JSON.stringify([id, kind, name]);
    const view = {
      draft: { skillRefs: [ref("a", "skill", "ocr")], mcpRefs: [ref("b", "mcp", "erp")] },
      resources: [
        {
          ref: ref("a", "skill", "ocr"),
          kind: "skill",
          name: "ocr",
          agentId: "a",
          agentName: "发票助手",
        },
        {
          ref: ref("a", "skill", "zip"),
          kind: "skill",
          name: "zip",
          agentId: "a",
          agentName: "发票助手",
        },
        {
          ref: ref("b", "mcp", "erp"),
          kind: "mcp",
          name: "erp",
          agentId: "b",
          agentName: "ERP 连接器",
        },
      ],
    } as const;
    expect(copiedFrom(view)).toEqual({ skill: { ocr: "发票助手" }, mcp: { erp: "ERP 连接器" } });
  });
  it("没有设计会话:空", () => {
    expect(copiedFrom(null)).toEqual({ skill: {}, mcp: {} });
  });
});
