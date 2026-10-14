import { overlayConfig } from "@/features/builder/builder";
import { describe, expect, it } from "vitest";

describe("overlayConfig(构建器保存时的配置合并)", () => {
  const base = {
    systemPrompt: "旧",
    effort: "high",
    skillPackages: [{ name: "a", description: "d", files: { "SKILL.md": "x" } }],
    outputSchema: { type: "object" },
    skills: ["pdf"],
  };

  it("表单不认识的字段原样保留(曾经保存一次就被清掉)", () => {
    const m = overlayConfig(base, { systemPrompt: "新" });
    expect(m.effort).toBe("high");
    expect(m.systemPrompt).toBe("新");
  });

  it("表单把某个字段清空:真的删掉,不让旧值冒出来", () => {
    const m = overlayConfig(base, { outputSchema: undefined });
    expect("outputSchema" in m).toBe(false);
    expect(JSON.parse(JSON.stringify(m)).outputSchema).toBeUndefined();
  });

  it("不再回写从未生效的旧技能名字段", () => {
    expect("skills" in overlayConfig(base, {})).toBe(false);
  });
});
