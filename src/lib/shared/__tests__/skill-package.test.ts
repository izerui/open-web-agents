import { renderSkillMarkdown, validateSkillPackages } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const ok = {
  name: "manim-scene",
  description: "用 Manim 渲染数学推导动画",
  files: { "SKILL.md": "# 步骤" },
};

describe("validateSkillPackages", () => {
  it("合法的技能包无问题", () => {
    expect(validateSkillPackages([ok])).toEqual([]);
    expect(validateSkillPackages(undefined)).toEqual([]);
  });

  it.each([
    ["技能名含大写", { ...ok, name: "Bad" }, /技能名/],
    ["缺少描述", { ...ok, description: " " }, /描述必填/],
    ["缺少 SKILL.md", { ...ok, files: { "a.py": "x" } }, /SKILL\.md/],
    ["路径上跳", { ...ok, files: { "SKILL.md": "x", "../evil.sh": "x" } }, /不允许的文件路径/],
    ["绝对路径", { ...ok, files: { "SKILL.md": "x", "/etc/passwd": "x" } }, /不允许的文件路径/],
  ])("%s 被拒", (_label, pkg, re) => {
    const issues = validateSkillPackages([pkg]);
    expect(issues.map((i) => i.message).join(" ")).toMatch(re);
  });

  it("重复技能名被拒", () => {
    expect(validateSkillPackages([ok, ok]).some((i) => /重复/.test(i.message))).toBe(true);
  });

  it("单文件超过 256KB 被拒", () => {
    const big = { ...ok, files: { "SKILL.md": "x".repeat(256 * 1024 + 1) } };
    expect(validateSkillPackages([big]).some((i) => /256KB/.test(i.message))).toBe(true);
  });
});

describe("renderSkillMarkdown", () => {
  it("用平台的名称与描述生成 frontmatter,替换作者自带的", () => {
    const md = renderSkillMarkdown({
      ...ok,
      files: { "SKILL.md": "---\nname: old\ndescription: old\n---\n\n正文" },
    });
    expect(md).toBe(
      '---\nname: manim-scene\ndescription: "用 Manim 渲染数学推导动画"\n---\n\n正文',
    );
  });
});
