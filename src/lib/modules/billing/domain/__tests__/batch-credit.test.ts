import { describe, expect, it } from "vitest";
import { MAX_BATCH_EMAILS, parseEmailList } from "../batch-credit";

describe("parseEmailList", () => {
  it("按换行、逗号、分号、空白拆分;统一小写;重复与格式错误标出来", () => {
    expect(parseEmailList(" A@x.com\nb@x.com, a@X.com；bad ;c@y.org ")).toEqual([
      { email: "a@x.com", status: "ok" },
      { email: "b@x.com", status: "ok" },
      { email: "a@x.com", status: "duplicate" },
      { email: "bad", status: "invalid" },
      { email: "c@y.org", status: "ok" },
    ]);
  });

  it("空清单与超过上限都拒绝", () => {
    expect(() => parseEmailList(" \n ,")).toThrow(/至少/);
    const many = Array.from({ length: MAX_BATCH_EMAILS + 1 }, (_, i) => `u${i}@x.com`).join("\n");
    expect(() => parseEmailList(many)).toThrow(/最多/);
  });
});
