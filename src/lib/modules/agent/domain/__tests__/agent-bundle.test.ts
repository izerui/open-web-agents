import { agentToBundle, bundleToAgent } from "@/lib/modules/agent/domain/agent-bundle";
import { describe, expect, it } from "vitest";

const agent = {
  name: "数学视频",
  description: "把数学推导做成动画视频",
  config: {
    systemPrompt: "你是数学动画导演",
    model: "opus" as const,
    maxTurns: 40,
    starters: ["推导基本不等式"],
    mcpServers: [{ name: "assets", type: "http" as const, url: "https://mcp.example.com" }],
    outputSchema: { type: "object", properties: { video: { type: "string" } } },
    skillPackages: [
      {
        name: "manim-scene",
        description: "用 Manim 渲染推导动画",
        files: { "SKILL.md": "# 步骤\n运行 scripts/render.py", "scripts/render.py": "print(1)" },
      },
    ],
  },
};

describe("智能体包", () => {
  it("导出再导入,配置原样往返", () => {
    const back = bundleToAgent(agentToBundle(agent));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.agent).toEqual(agent);
  });

  it("技能的描述写在 SKILL.md 的 frontmatter 里", () => {
    const files = agentToBundle(agent);
    expect(files["agent/skills/manim-scene/SKILL.md"]).toMatch(
      /^---\ndescription: "用 Manim 渲染推导动画"\n---\n/,
    );
  });

  it("缺 agent.json、JSON 写错、提示词为空、不认识的字段:逐条报出", () => {
    expect(bundleToAgent({})).toMatchObject({ ok: false });
    const bad = bundleToAgent({
      "agent/agent.json": "{ not json",
      "agent/system-prompt.md": "p",
    });
    expect(bad.ok === false && bad.issues[0]?.message).toMatch(/JSON/);
    const r = bundleToAgent({
      "agent/agent.json": JSON.stringify({ name: "x", webhookUrl: "https://evil" }),
      "agent/system-prompt.md": "  ",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msgs = r.issues.map((i) => i.message).join(" ");
    // webhook、逃生舱这类字段不能从设计会话里改
    expect(msgs).toMatch(/webhookUrl/);
    expect(msgs).toMatch(/系统提示词/);
  });

  it("技能目录缺 SKILL.md 时报出", () => {
    const r = bundleToAgent({
      "agent/agent.json": JSON.stringify({ name: "x" }),
      "agent/system-prompt.md": "p",
      "agent/skills/foo/run.sh": "echo",
    });
    expect(r.ok === false && r.issues[0]?.message).toMatch(/SKILL\.md/);
  });

  it("不写模型时默认 sonnet", () => {
    const r = bundleToAgent({
      "agent/agent.json": JSON.stringify({ name: "x" }),
      "agent/system-prompt.md": "p",
    });
    expect(r.ok && r.agent.config.model).toBe("sonnet");
  });
});
