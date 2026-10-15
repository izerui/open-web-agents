import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializeSkillPlugin } from "@/lib/modules/agent-engine/adapters/claude-sdk/skill-plugin";
import { validateSkillPackages } from "@/lib/shared/skill-package";
import { afterAll, describe, expect, it } from "vitest";
import { SKILL_EXAMPLE } from "../architect";

const tmpDirs: string[] = [];
async function tmpDir(prefix: string) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("SKILL_EXAMPLE", () => {
  it("通过 SkillPackage 校验", () => {
    const issues = validateSkillPackages([SKILL_EXAMPLE]);
    expect(issues).toEqual([]);
  });

  it("JSON.stringify 产出的 JSON 能 parse 回原对象", () => {
    const json = JSON.stringify(SKILL_EXAMPLE);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("csv-summary");
    expect(parsed.files["SKILL.md"]).toContain("步骤");
    expect(parsed.files["scripts/summarize.py"]).toContain("__file__");
  });

  it("落盘后从会话工作目录执行脚本能读到配套文件", async () => {
    const pluginRoot = await tmpDir("owa-skill-test-");
    const sessionDir = await tmpDir("owa-session-");

    // 落盘
    const pluginDir = await materializeSkillPlugin(pluginRoot, [SKILL_EXAMPLE]);
    if (!pluginDir) throw new Error("materializeSkillPlugin returned undefined");

    // 验证文件结构
    const skillDir = path.join(pluginDir, "skills", "csv-summary");
    const skillMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    expect(skillMd).toContain("步骤");
    const script = path.join(skillDir, "scripts", "summarize.py");
    const scriptContent = await fs.readFile(script, "utf-8");
    expect(scriptContent).toContain("SKILL_DIR");
    expect(scriptContent).toContain("settings.json");
    const cfgContent = await fs.readFile(path.join(skillDir, "config", "settings.json"), "utf-8");
    expect(JSON.parse(cfgContent)).toEqual({ preview_rows: 3 });

    // 在会话工作目录创建测试 CSV（5 行数据，但配置限制预览 3 行）
    const csvPath = path.join(sessionDir, "data.csv");
    await fs.writeFile(
      csvPath,
      "name,age,city\nAlice,30,Beijing\nBob,25,Shanghai\nCharlie,28,Guangzhou\nDave,35,Shenzhen\nEve,22,Hangzhou\n",
    );

    // 从会话工作目录执行脚本（模拟真实运行环境：cwd ≠ 技能目录）
    const output = execSync(`python3 "${script}" "${csvPath}"`, {
      cwd: sessionDir,
      encoding: "utf-8",
    });

    expect(output).toContain("列: name, age, city");
    expect(output).toContain("行数: 5");
    // config/settings.json 的 preview_rows=3 限制了预览行数
    expect(output).toContain("Alice");
    expect(output).toContain("Bob");
    expect(output).toContain("Charlie");
    expect(output).not.toContain("Dave");
    expect(output).not.toContain("Eve");
  });
});
