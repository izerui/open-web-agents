import { buildSpec } from "@/lib/modules/assistant/domain/build-spec";
import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";
import type { RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const ctx: RunContext = {
  workspaceDir: "/ws",
  prompt: "hi",
  credentials: { baseUrl: "b", key: "k" },
  env: {},
};

describe("buildSpec", () => {
  it("最小配置产出合法 AgentSpec", () => {
    const spec = buildSpec({ systemPrompt: "你是助手", model: "sonnet" }, ctx);
    expect(spec.systemPrompt).toBe("你是助手");
    expect(spec.model).toEqual({ alias: "sonnet" });
    expect(spec.limits).toEqual({ maxTurns: undefined, effort: undefined });
    expect(spec.outputSchema).toBeUndefined();
  });

  it("effort/maxTurns 映射进 limits", () => {
    const spec = buildSpec({ systemPrompt: "p", model: "opus", effort: "high", maxTurns: 20 }, ctx);
    expect(spec.limits).toEqual({ maxTurns: 20, effort: "high" });
  });

  it("outputSchema / verifyRules 透传", () => {
    const cfg: AssistantConfig = {
      systemPrompt: "p",
      model: "opus",
      outputSchema: { type: "object" },
      verifyRules: [{ kind: "artifact_exists" }],
    };
    const spec = buildSpec(cfg, ctx);
    expect(spec.outputSchema).toEqual({ type: "object" });
    expect(spec.verifyRules).toEqual([{ kind: "artifact_exists" }]);
  });

  it("escapeHatch 透传", () => {
    const spec = buildSpec(
      { systemPrompt: "p", model: "haiku", escapeHatch: { includePartialMessages: true } },
      ctx,
    );
    expect(spec.escapeHatch).toEqual({ includePartialMessages: true });
  });

  it("透传 skills/mcp/tools", () => {
    const spec = buildSpec(
      {
        systemPrompt: "p",
        model: "sonnet",
        skills: ["pdf"],
        mcpServers: [{ name: "fs", type: "http", url: "http://x" }],
        tools: [{ name: "render" }],
      },
      ctx,
    );
    expect(spec.skills).toEqual(["pdf"]);
    expect(spec.mcpServers?.[0]?.name).toBe("fs");
    expect(spec.tools?.[0]?.name).toBe("render");
  });

  it("子代理强制同步执行(background 恒为 false)", () => {
    const spec = buildSpec(
      {
        systemPrompt: "p",
        model: "sonnet",
        subagents: [{ name: "rev", prompt: "审", background: false }],
      },
      ctx,
    );
    expect(spec.subagents?.[0]).toEqual({ name: "rev", prompt: "审", background: false });
  });

  it("模型别名可被请求级覆盖", () => {
    const spec = buildSpec({ systemPrompt: "p", model: "sonnet" }, ctx, { model: "haiku" });
    expect(spec.model).toEqual({ alias: "haiku" });
  });
});
