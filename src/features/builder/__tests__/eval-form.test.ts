import {
  EMPTY_FORM,
  buildCaseBody,
  formFromCase,
  summarizeAssertions,
} from "@/features/builder/eval-form";
import { describe, expect, it } from "vitest";

describe("评测用例表单", () => {
  it("文本输入 + 各类断言 → 请求体;默认期望成功不写出来", () => {
    const r = buildCaseBody({
      ...EMPTY_FORM,
      name: " 合同 A ",
      input: " 审查这份合同 ",
      contains: "完成\n\n 风险 ",
      notContains: "抱歉",
      fieldEquals: 'verdict = "pass"\nscore = 88\nlevel = low',
      maxCostUsd: "0.05",
      maxDurationSec: "30",
    });
    expect(r).toEqual({
      ok: true,
      body: {
        name: "合同 A",
        input: "审查这份合同",
        assertions: {
          contains: ["完成", "风险"],
          notContains: ["抱歉"],
          fieldEquals: [
            { path: "verdict", value: "pass" },
            { path: "score", value: 88 },
            { path: "level", value: "low" },
          ],
          maxCostUsd: 0.05,
          maxDurationMs: 30_000,
        },
      },
    });
  });

  it("结构化输入须为 JSON 对象;期望失败写出 false", () => {
    expect(
      buildCaseBody({ ...EMPTY_FORM, name: "x", input: "{bad", inputIsJson: true }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      buildCaseBody({ ...EMPTY_FORM, name: "x", input: "[1]", inputIsJson: true }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      buildCaseBody({
        ...EMPTY_FORM,
        name: "x",
        input: '{"a":1}',
        inputIsJson: true,
        expectSuccess: false,
      }),
    ).toEqual({
      ok: true,
      body: { name: "x", input: { a: 1 }, assertions: { expectSuccess: false } },
    });
  });

  it("缺名、缺输入、字段等于格式不对、上限不是正数:都给出说明", () => {
    for (const f of [
      { ...EMPTY_FORM, input: "x" },
      { ...EMPTY_FORM, name: "x" },
      { ...EMPTY_FORM, name: "x", input: "y", fieldEquals: "没有等号" },
      { ...EMPTY_FORM, name: "x", input: "y", maxCostUsd: "-1" },
      { ...EMPTY_FORM, name: "x", input: "y", maxDurationSec: "abc" },
    ]) {
      expect(buildCaseBody(f).ok).toBe(false);
    }
  });

  it("从已有用例回填表单,再转回去内容不变", () => {
    const c = {
      name: "合同",
      input: { contract: "甲方" },
      assertions: {
        expectSuccess: false,
        contains: ["a"],
        fieldEquals: [{ path: "x.y", value: [1, 2] }],
        maxDurationMs: 1500,
      },
    };
    const back = buildCaseBody(formFromCase(c));
    expect(back).toEqual({ ok: true, body: c });
  });

  it("断言摘要", () => {
    expect(
      summarizeAssertions({
        contains: ["完成"],
        fieldEquals: [{ path: "v", value: "pass" }],
        maxCostUsd: 0.1,
      }),
    ).toBe('期望成功 · 含 「完成」 · v = "pass" · ≤ $0.1');
  });
});
