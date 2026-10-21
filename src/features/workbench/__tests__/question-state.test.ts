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
      questionState(q("x"), { text: "用户选择不回答", isError: true }, undefined, false).kind,
    ).toBe("declined");
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
