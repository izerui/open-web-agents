import { describe, expect, it } from "vitest";
import { splitDoc, titleOf } from "../split-doc";

describe("splitDoc", () => {
  it("不超过上限:原样一篇", () => {
    expect(splitDoc("制度", "短", 10)).toEqual([{ title: "制度", content: "短" }]);
  });
  it("超过上限:按顺序切成几篇,优先在空行处切;每篇不超上限,内容不丢", () => {
    const text = `${"甲".repeat(80)}\n\n${"乙".repeat(80)}\n\n${"丙".repeat(30)}`;
    const parts = splitDoc("教材", text, 100);
    expect(parts.map((p) => p.title)).toEqual(["教材(1/3)", "教材(2/3)", "教材(3/3)"]);
    expect(parts.map((p) => p.content)).toEqual([
      "甲".repeat(80),
      "乙".repeat(80),
      "丙".repeat(30),
    ]);
    expect(parts.every((p) => [...p.content].length <= 100)).toBe(true);
  });
  it("没有换行时在上限处硬切;按字符(码点)算,不切坏 emoji", () => {
    const parts = splitDoc("t", "😀".repeat(25), 10);
    expect(parts.map((p) => [...p.content].length)).toEqual([10, 10, 5]);
    expect(parts.join("")).not.toContain("\uFFFD");
  });
});

describe("titleOf", () => {
  it("去掉扩展名与路径,限长", () => {
    expect(titleOf("资料/报销制度.v2.docx")).toBe("报销制度.v2");
    expect(titleOf("C:\\a\\b.pdf")).toBe("b");
    expect([...titleOf(`${"长".repeat(300)}.pdf`)].length).toBe(240);
  });
});
