import { validateAssistantConfig } from "@/lib/modules/assistant/domain/validate-config";
import { describe, expect, it } from "vitest";

const ok = { systemPrompt: "你是助手", model: "sonnet" as const };

/** 断言某字段有问题;比只断言"有几个问题"更能定位回归。 */
function fields(cfg: Parameters<typeof validateAssistantConfig>[0]): string[] {
  return validateAssistantConfig(cfg).map((i) => i.field);
}

describe("validateAssistantConfig / 基础字段", () => {
  it("最小合法配置无问题", () => {
    expect(validateAssistantConfig(ok)).toEqual([]);
  });

  it("空提示词被拦", () => {
    expect(fields({ ...ok, systemPrompt: "   " })).toContain("systemPrompt");
  });

  it("未知模型别名被拦", () => {
    expect(fields({ ...ok, model: "gpt5" as never })).toContain("model");
  });

  it("非法 effort 被拦", () => {
    expect(fields({ ...ok, effort: "extreme" as never })).toContain("effort");
  });

  it("maxTurns 越界或非整数被拦", () => {
    expect(fields({ ...ok, maxTurns: 0 })).toContain("maxTurns");
    expect(fields({ ...ok, maxTurns: 1000 })).toContain("maxTurns");
    expect(fields({ ...ok, maxTurns: 1.5 })).toContain("maxTurns");
  });

  it("一次性报出所有问题,不是遇到第一个就停", () => {
    const issues = validateAssistantConfig({ systemPrompt: "", model: "x" as never, maxTurns: 0 });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateAssistantConfig / MCP", () => {
  it("合法 http MCP 通过", () => {
    expect(
      validateAssistantConfig({
        ...ok,
        mcpServers: [{ name: "fs", type: "http", url: "https://mcp.example.com" }],
      }),
    ).toEqual([]);
  });

  it("非法名称被拦(会成为 SDK options 的 key)", () => {
    expect(
      fields({ ...ok, mcpServers: [{ name: "bad name!", type: "http", url: "https://x.com" }] }),
    ).toContain("mcpServers[0].name");
  });

  it("重名被拦 —— 否则组装时互相覆盖、静默丢一个", () => {
    const f = fields({
      ...ok,
      mcpServers: [
        { name: "dup", type: "http", url: "https://a.com" },
        { name: "dup", type: "http", url: "https://b.com" },
      ],
    });
    expect(f).toContain("mcpServers[1].name");
  });

  it("http 类型缺 url 被拦", () => {
    expect(fields({ ...ok, mcpServers: [{ name: "fs", type: "http" }] })).toContain(
      "mcpServers[0].url",
    );
  });

  it("url 格式错或协议不支持被拦", () => {
    expect(fields({ ...ok, mcpServers: [{ name: "a", type: "http", url: "notaurl" }] })).toContain(
      "mcpServers[0].url",
    );
    expect(
      fields({ ...ok, mcpServers: [{ name: "a", type: "http", url: "file:///etc/passwd" }] }),
    ).toContain("mcpServers[0].url");
  });

  it("未知类型被拦", () => {
    expect(fields({ ...ok, mcpServers: [{ name: "a", type: "grpc" as never }] })).toContain(
      "mcpServers[0].type",
    );
  });

  it("stdio 类型不要求 url", () => {
    expect(
      validateAssistantConfig({ ...ok, mcpServers: [{ name: "local", type: "stdio" }] }),
    ).toEqual([]);
  });
});

describe("validateAssistantConfig / skills 与子代理", () => {
  it("空技能名与重复技能被拦", () => {
    expect(fields({ ...ok, skills: [""] })).toContain("skills[0]");
    expect(fields({ ...ok, skills: ["pdf", "pdf"] })).toContain("skills[1]");
  });

  it("合法技能列表通过", () => {
    expect(validateAssistantConfig({ ...ok, skills: ["pdf", "xlsx"] })).toEqual([]);
  });

  it("子代理缺名或缺提示词被拦", () => {
    const f = fields({
      ...ok,
      subagents: [{ name: "", prompt: "", background: false }],
    });
    expect(f).toContain("subagents[0].name");
    expect(f).toContain("subagents[0].prompt");
  });

  it("子代理重名被拦", () => {
    expect(
      fields({
        ...ok,
        subagents: [
          { name: "rev", prompt: "a", background: false },
          { name: "rev", prompt: "b", background: false },
        ],
      }),
    ).toContain("subagents[1].name");
  });
});

describe("validateAssistantConfig / outputSchema", () => {
  it("顶层 object 通过", () => {
    expect(validateAssistantConfig({ ...ok, outputSchema: { type: "object" } })).toEqual([]);
  });

  it("顶层数组被拦(调用方按字段取值,数组当不了接口契约)", () => {
    expect(fields({ ...ok, outputSchema: { type: "array" } })).toContain("outputSchema.type");
  });

  it("未声明 type 时不强求(交给 ajv 在运行时判)", () => {
    expect(validateAssistantConfig({ ...ok, outputSchema: { properties: {} } })).toEqual([]);
  });
});
