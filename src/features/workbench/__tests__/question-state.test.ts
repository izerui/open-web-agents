import { describe, expect, it } from "vitest";
import { answerText, parseAnswered, questionState } from "../question-state";

const q = (...texts: string[]) => ({
  kind: "question" as const,
  toolUseId: "t1",
  questions: texts.map((question) => ({ question, options: [{ label: "A" }] })),
});
const sdkAnswered = (pairs: [string, string][]) =>
  `The user answered: ${pairs.map(([k, v]) => `"${k}"="${v}"`).join(", ")}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;

describe("parseAnswered", () => {
  it("按题目原文取出每题回答;回答里带引号、逗号也不切错", () => {
    const text = sdkAnswered([
      ["格式?", 'Word、"带目录"'],
      ["语言?", "中文, 英文"],
    ]);
    expect(parseAnswered(text, ["格式?", "语言?"])).toEqual(['Word、"带目录"', "中文, 英文"]);
  });
  it("对不上返回 null;只缺一题时那题为 null", () => {
    expect(parseAnswered("The user did not answer the questions.", ["x"])).toBeNull();
    expect(parseAnswered(sdkAnswered([["a?", "1"]]), ["a?", "b?"])).toEqual(["1", null]);
  });
});

describe("questionState", () => {
  const pending = { id: "ap1", toolUseId: "t1", questions: q("x").questions, expiresAt: 1 };
  it("有工具结果:已回答 / 不回答 / 未回答", () => {
    expect(
      questionState(q("x"), { text: sdkAnswered([["x", "A"]]), isError: false }, undefined, false),
    ).toMatchObject({ kind: "answered", answers: ["A"] });
    expect(
      questionState(
        q("x"),
        { text: "用户选择不回答这些问题。请按你的判断继续", isError: true },
        undefined,
        false,
      ).kind,
    ).toBe("declined");
    // SDK 校验提问格式失败:用户什么都没做,不能显示成"你选择了不回答"
    expect(
      questionState(
        q("x"),
        { text: "<tool_use_error>InputValidationError: AskUserQuestion failed", isError: true },
        undefined,
        false,
      ).kind,
    ).toBe("invalid");
    expect(
      questionState(
        q("x"),
        { text: "The user did not answer the questions.", isError: false },
        pending,
        false,
      ).kind,
    ).toBe("unanswered");
  });
  it("没有结果:待回答 > 运行中等待 > 旧记录", () => {
    expect(questionState(q("x"), undefined, pending, true)).toEqual({
      kind: "pending",
      request: pending,
    });
    expect(questionState(q("x"), undefined, undefined, true).kind).toBe("waiting");
    expect(questionState(q("x"), undefined, undefined, false).kind).toBe("legacy");
  });
});

describe("answerText", () => {
  it("选项加自己填写的,用、连接;空的自填不算", () => {
    expect(answerText(["PDF", "Word"], " 带目录 ")).toBe("PDF、Word、带目录");
    expect(answerText([], "只用自填")).toBe("只用自填");
    expect(answerText(["PDF"], "  ")).toBe("PDF");
  });
});

describe("questionState:结构化回答优先", () => {
  it("有结构化回答时按题目对上,不靠被截断的工具结果文本", () => {
    const truncated = { text: 'The user answered: "a?"="xx…(已截断)', isError: false };
    const s = questionState(q("a?", "b?"), truncated, undefined, false, {
      kind: "answer",
      toolUseId: "t1",
      answers: [
        { question: "a?", answer: "完整的甲" },
        { question: "b?", answer: "完整的乙" },
      ],
    });
    expect(s).toMatchObject({ kind: "answered", answers: ["完整的甲", "完整的乙"] });
  });
});
