import { describe, expect, it } from "vitest";
import { parseCaseBody } from "../case-body";

const base = { name: "超额需审批", input: "报销 5000 元", assertions: { contains: ["审批"] } };

describe("评测用例请求体:来源", () => {
  it("不带来源 = manual;带 trial 原样保留", () => {
    expect(parseCaseBody(base)).toMatchObject({ ok: true, value: { source: "manual" } });
    expect(parseCaseBody({ ...base, source: "trial" })).toMatchObject({
      ok: true,
      value: { source: "trial" },
    });
    expect(parseCaseBody({ ...base, source: "manual" })).toMatchObject({
      ok: true,
      value: { source: "manual" },
    });
  });

  it("未知来源 → 校验失败", () => {
    for (const source of ["chat", 1, null]) {
      expect(parseCaseBody({ ...base, source })).toEqual({
        ok: false,
        reason: "source 须为 manual 或 trial",
      });
    }
  });
});
