import {
  OUTPUT_STRUCTURED_MAX,
  OUTPUT_TEXT_MAX,
  gradeRun,
  parsePath,
  snapshotOutput,
  validateAssertions,
} from "@/lib/modules/eval/domain/assertions";
import { describe, expect, it } from "vitest";

const ok = {
  status: "success",
  structured: { verdict: "pass", issues: [{ level: "low", tags: ["a"] }] },
  text: "合同审查完成,未发现高风险条款",
  error: null,
  cost: { usd: 0.012 },
  durationMs: 8_000,
};

describe("gradeRun", () => {
  it("默认期望成功:成功且无其它断言即通过;失败时给出原因", () => {
    expect(gradeRun({}, ok)).toEqual({ passed: true, failures: [] });
    const g = gradeRun({}, { ...ok, status: "failed", error: { message: "上游 503" } });
    expect(g.passed).toBe(false);
    expect(g.failures[0]).toMatch(/期望运行成功,实际 failed:上游 503/);
  });

  it("期望失败的用例:失败算通过,成功反而不通过", () => {
    expect(gradeRun({ expectSuccess: false }, { ...ok, status: "failed" }).passed).toBe(true);
    expect(gradeRun({ expectSuccess: false }, ok).failures).toEqual(["期望运行失败,实际成功"]);
  });

  it("正文包含 / 不包含:大小写不敏感", () => {
    expect(gradeRun({ contains: ["审查完成"], notContains: ["高风险条款已标出"] }, ok).passed).toBe(
      true,
    );
    expect(gradeRun({ contains: ["ABC"] }, { ...ok, text: "xx abc" }).passed).toBe(true);
    expect(gradeRun({ notContains: ["高风险"] }, ok).failures).toEqual([
      "正文含有不该出现的「高风险」",
    ]);
    expect(gradeRun({ contains: ["x"] }, { ...ok, text: null }).failures).toEqual([
      "正文不含「x」",
    ]);
  });

  it("结构化字段等于:支持嵌套与下标,深比较;缺字段与不相等各自说明", () => {
    expect(
      gradeRun(
        {
          fieldEquals: [
            { path: "verdict", value: "pass" },
            { path: "issues[0].tags", value: ["a"] },
          ],
        },
        ok,
      ).passed,
    ).toBe(true);
    expect(gradeRun({ fieldEquals: [{ path: "verdict", value: "fail" }] }, ok).failures).toEqual([
      'verdict 期望 "fail",实际 "pass"',
    ]);
    expect(
      gradeRun({ fieldEquals: [{ path: "issues[3].level", value: "x" }] }, ok).failures,
    ).toEqual(["结构化结果里没有 issues[3].level"]);
  });

  it("花费与耗时上限;未知时不默认通过", () => {
    expect(gradeRun({ maxCostUsd: 0.05, maxDurationMs: 10_000 }, ok).passed).toBe(true);
    expect(gradeRun({ maxCostUsd: 0.01 }, ok).failures[0]).toMatch(/超过上限/);
    expect(gradeRun({ maxDurationMs: 5_000 }, ok).failures[0]).toMatch(/耗时 8000ms 超过上限/);
    expect(gradeRun({ maxCostUsd: 1 }, { ...ok, cost: null }).failures[0]).toMatch(/花费未知/);
    expect(gradeRun({ maxDurationMs: 1 }, { ...ok, durationMs: null }).failures[0]).toMatch(
      /耗时未知/,
    );
  });
});

describe("validateAssertions / parsePath", () => {
  it("合法的断言原样通过(文本去首尾空白);不传 = 空断言", () => {
    expect(validateAssertions(undefined)).toEqual({ ok: true, value: {} });
    expect(
      validateAssertions({
        contains: [" 完成 "],
        fieldEquals: [{ path: "a.b[0]", value: 1 }],
        maxCostUsd: 0.1,
      }),
    ).toEqual({
      ok: true,
      value: { contains: ["完成"], fieldEquals: [{ path: "a.b[0]", value: 1 }], maxCostUsd: 0.1 },
    });
  });

  it("不合法的一律拒绝并说明", () => {
    for (const bad of [
      [],
      { expectSuccess: "yes" },
      { contains: [""] },
      { contains: "x" },
      { fieldEquals: [{ path: "a..b", value: 1 }] },
      { fieldEquals: [{ path: "a" }] },
      { maxCostUsd: 0 },
      { maxDurationMs: -1 },
    ]) {
      expect(validateAssertions(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("路径解析", () => {
    expect(parsePath("a.b[0].c")).toEqual(["a", "b", 0, "c"]);
    expect(parsePath("items[1][2]")).toEqual(["items", 1, 2]);
    expect(parsePath("a b")).toBeNull();
    expect(parsePath("")).toBeNull();
  });
});

describe("snapshotOutput(判分时看到的输出)", () => {
  it("原样保存状态、正文、结构化结果与错误", () => {
    expect(
      snapshotOutput({
        status: "failed",
        text: "回复",
        structured: { verdict: "pass" },
        error: { message: "上游 503" },
      }),
    ).toEqual({
      status: "failed",
      text: "回复",
      structured: { verdict: "pass" },
      error: "上游 503",
    });
    expect(
      snapshotOutput({ status: "success", text: null, structured: null, error: null }),
    ).toEqual({
      status: "success",
    });
  });

  it("正文超长按字符截断并标明;不把表情(代理对)切成半个", () => {
    const text = `${"字".repeat(OUTPUT_TEXT_MAX - 1)}😀尾巴`;
    const s = snapshotOutput({ status: "success", text, structured: null, error: null });
    expect(s.textTruncated).toBe(true);
    expect(Array.from(s.text ?? "")).toHaveLength(OUTPUT_TEXT_MAX);
    expect(s.text?.endsWith("😀")).toBe(true);
    expect(
      snapshotOutput({ status: "success", text: "短", structured: null, error: null })
        .textTruncated,
    ).toBeUndefined();
  });

  it("结构化结果过大:不存原对象,只存序列化后的开头", () => {
    const big = { items: Array.from({ length: 2_000 }, (_, i) => `item-${i}`) };
    const s = snapshotOutput({ status: "success", text: null, structured: big, error: null });
    expect(s.structured).toBeUndefined();
    expect(s.structuredPreview).toHaveLength(OUTPUT_STRUCTURED_MAX);
    expect(JSON.stringify(big).startsWith(s.structuredPreview ?? "x")).toBe(true);
  });
});
