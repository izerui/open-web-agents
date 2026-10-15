import { findPathConflict, renderSkillMarkdown, validateSkillPackages } from "@/lib/shared";
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

describe("findPathConflict", () => {
  it("无冲突时返回 null", () => {
    expect(findPathConflict(["SKILL.md", "scripts/run.py", "config/settings.json"])).toBeNull();
  });

  it("文件路径是另一个文件的父目录时报冲突", () => {
    const msg = findPathConflict(["scripts", "scripts/run.py"]);
    expect(msg).toContain("scripts");
    expect(msg).toContain("scripts/run.py");
  });

  it("SKILL.md/notes.txt 被拒", () => {
    const msg = findPathConflict(["SKILL.md", "SKILL.md/notes.txt"]);
    expect(msg).toContain("SKILL.md");
  });

  it("先添加子路径再添加父路径同样被拒", () => {
    const msg = findPathConflict(["scripts/run.py", "scripts"]);
    expect(msg).toContain("scripts");
  });

  it("同前缀但不是父子关系不报冲突", () => {
    expect(findPathConflict(["scripts-v2.py", "scripts/run.py"])).toBeNull();
  });

  it("中间隔着干扰文件仍能检测到冲突", () => {
    const msg = findPathConflict(["scripts", "scripts-old.py", "scripts/run.py"]);
    expect(msg).toContain("scripts");
    expect(msg).toContain("scripts/run.py");
  });

  it("深层祖先冲突也检测到", () => {
    const msg = findPathConflict(["a", "a/b/c.txt"]);
    expect(msg).toContain("a");
    expect(msg).toContain("a/b/c.txt");
  });
});

describe("validateSkillPackages 路径冲突", () => {
  it("文件与目录冲突在校验时被拒", () => {
    const pkg = {
      ...ok,
      files: { "SKILL.md": "x", scripts: "raw content", "scripts/run.py": "print(1)" },
    };
    const issues = validateSkillPackages([pkg]);
    expect(issues.some((i) => /冲突/.test(i.message))).toBe(true);
  });

  it("正常的脚本加配置目录通过校验", () => {
    const pkg = {
      ...ok,
      files: { "SKILL.md": "x", "scripts/run.py": "print(1)", "config/settings.json": "{}" },
    };
    expect(validateSkillPackages([pkg])).toEqual([]);
  });

  it("中间隔着干扰文件的冲突也被拒", () => {
    const pkg = {
      ...ok,
      files: {
        "SKILL.md": "x",
        scripts: "raw",
        "scripts-old.py": "old",
        "scripts/run.py": "print(1)",
      },
    };
    const issues = validateSkillPackages([pkg]);
    expect(issues.some((i) => /冲突/.test(i.message))).toBe(true);
  });
});
