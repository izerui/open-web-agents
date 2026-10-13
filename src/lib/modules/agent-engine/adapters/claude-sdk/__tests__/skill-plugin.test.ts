import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeSkillPlugin } from "@/lib/modules/agent-engine/adapters/claude-sdk/skill-plugin";
import { afterEach, describe, expect, it } from "vitest";

const pkg = {
  name: "manim-scene",
  description: "用 Manim 渲染数学推导动画",
  files: { "SKILL.md": "# 步骤\n运行 scripts/render.py", "scripts/render.py": "print('hi')" },
};

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("materializeSkillPlugin", () => {
  it("写出 SDK 能识别的插件结构:清单 + skills/<名称>/SKILL.md + 附带文件", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-skills-"));
    const dir = await materializeSkillPlugin(root, [pkg]);
    expect(dir).toBeTruthy();
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir!, ".claude-plugin/plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("skills");
    const md = await fs.readFile(path.join(dir!, "skills/manim-scene/SKILL.md"), "utf8");
    expect(md).toMatch(/^---\nname: manim-scene\n/);
    expect(await fs.readFile(path.join(dir!, "skills/manim-scene/scripts/render.py"), "utf8")).toBe(
      "print('hi')",
    );
  });

  it("同样的内容复用同一个目录;内容一变就换目录", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-skills-"));
    const a = await materializeSkillPlugin(root, [pkg]);
    const b = await materializeSkillPlugin(root, [pkg]);
    const c = await materializeSkillPlugin(root, [{ ...pkg, description: "换了描述" }]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("并发生成同一份技能包不会互相破坏", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-skills-"));
    const dirs = await Promise.all([1, 2, 3, 4].map(() => materializeSkillPlugin(root, [pkg])));
    expect(new Set(dirs).size).toBe(1);
    const leftovers = (await fs.readdir(root)).filter((n) => n.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("文件路径逃逸直接拒绝", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-skills-"));
    await expect(
      materializeSkillPlugin(root, [{ ...pkg, files: { "SKILL.md": "x", "../../x": "y" } }]),
    ).rejects.toThrow(/unsafe/);
  });

  it("没有技能包时不生成", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-skills-"));
    expect(await materializeSkillPlugin(root, [])).toBeUndefined();
  });
});
