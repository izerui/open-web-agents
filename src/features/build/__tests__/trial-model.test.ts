import type { Turn } from "@/features/workbench/types";
import { describe, expect, it } from "vitest";
import { caseFormFromTrial, trialCaseNote, turnAnswer, turnDurationText } from "../trial-model";

describe("caseFormFromTrial:试聊一轮存为评测用例(A6)", () => {
  it("输入取这一轮提问,结构化回答预填「字段等于」", () => {
    const f = caseFormFromTrial({
      prompt: "这张 6800 元的机票能报吗？",
      answer: "需要审批",
      structured: {
        verdict: "need_approval",
        reasons: ["超额"],
        score: 3,
        ok: false,
        reason: "金额超过单笔 5000 元，需要部门负责人审批",
      },
      hasInputSchema: false,
    });
    expect(f.name).toBe("这张 6800 元的机票能报吗");
    expect(f.input).toBe("这张 6800 元的机票能报吗？");
    expect(f.inputIsJson).toBe(false);
    expect(f.expectSuccess).toBe(true);
    expect(f.fieldEquals).toBe('verdict = "need_approval"\nscore = 3\nok = false');
    expect(f.contains).toBe("");
  });

  it("文本回答:不拿整句当「须包含」(重跑几乎一定不通过),留给用户填关键词", () => {
    const f = caseFormFromTrial({
      prompt: "美元发票怎么换算",
      answer: "按开票日汇率换算。具体是……",
      hasInputSchema: false,
    });
    expect(f.contains).toBe("");
    expect(f.fieldEquals).toBe("");
    expect(trialCaseNote({ structured: undefined })).toContain("关键词");
    expect(trialCaseNote({ structured: { a: 1 } })).not.toContain("关键词");
  });

  it("有 inputSchema 且提问是 JSON 对象时按 JSON 解析", () => {
    const f = caseFormFromTrial({ prompt: '{"amount": 1}', answer: "", hasInputSchema: true });
    expect(f.inputIsJson).toBe(true);
    expect(f.name).toBe("用例");
    const g = caseFormFromTrial({ prompt: "文本", answer: "", hasInputSchema: true });
    expect(g.inputIsJson).toBe(false);
  });

  it("用例名最多 20 字", () => {
    const f = caseFormFromTrial({ prompt: "一".repeat(40), answer: "x", hasInputSchema: false });
    expect(f.name).toHaveLength(20);
  });
});

describe("一轮的回答与耗时", () => {
  const turn = (events: Turn["events"], extra: Partial<Turn> = {}): Turn => ({
    prompt: "p",
    events,
    running: false,
    ...extra,
  });
  it("回答取文本与结构化结果", () => {
    const t = turn([
      { kind: "text", text: "你好" },
      { kind: "text", text: "，世界" },
      { kind: "result", status: "success", structured: { a: 1 } },
    ] as Turn["events"]);
    expect(turnAnswer(t)).toEqual({ text: "你好，世界", structured: { a: 1 } });
  });
  it("耗时", () => {
    const t = turn([], { startedAt: "2026-01-01T00:00:00.000Z" });
    expect(turnDurationText(t, Date.parse("2026-01-01T00:00:04.230Z"))).toBe("4.2s");
    expect(turnDurationText(t, Date.parse("2026-01-01T00:01:05.000Z"))).toBe("1 分 5 秒");
    expect(turnDurationText(turn([]), 5)).toBeNull();
    expect(turnDurationText(t, undefined)).toBeNull();
  });
});
