import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import { describe, expect, it } from "vitest";
import { buildSpec, checkRequiredVariables, splitVariables } from "../build-spec";

const ctx = {
  sessionId: "s1",
  runId: "r1",
  workspaceDir: "/tmp/ws",
  prompt: "test",
  env: {},
  credentials: { baseUrl: "http://localhost", key: "k" },
};

const baseCfg: AgentConfig = {
  systemPrompt: "You have access to {{API_KEY}} and {{BASE_URL}}",
  model: "sonnet",
  maxTurns: 10,
  mcpServers: [
    { type: "http", name: "api", url: "https://{{BASE_URL}}/v1", env: { TOKEN: "{{API_KEY}}" } },
  ],
  skillPackages: [
    {
      name: "demo",
      description: "d",
      files: { "SKILL.md": "Use {{API_KEY}} to call API at {{BASE_URL}}" },
    },
  ],
  variables: [
    { name: "API_KEY", description: "密钥", required: true, secret: true },
    { name: "BASE_URL", description: "地址", required: true, secret: false },
  ],
};

describe("variable injection", () => {
  it("secret variables do NOT appear in systemPrompt or skill files", () => {
    const spec = buildSpec(baseCfg, ctx, {
      resolvedVariables: { API_KEY: "sk-secret-123", BASE_URL: "api.example.com" },
    });

    expect(spec.systemPrompt).not.toContain("sk-secret-123");
    expect(spec.systemPrompt).toContain("api.example.com");
    expect(spec.systemPrompt).toContain("{{API_KEY}}");

    const skillContent = spec.skillPackages?.[0]?.files["SKILL.md"];
    expect(skillContent).not.toContain("sk-secret-123");
    expect(skillContent).toContain("{{API_KEY}}");
    expect(skillContent).toContain("{{BASE_URL}}");
  });

  it("secret variables ARE injected into MCP env values", () => {
    const spec = buildSpec(baseCfg, ctx, {
      resolvedVariables: { API_KEY: "sk-secret-123", BASE_URL: "api.example.com" },
    });

    const mcp = spec.mcpServers?.[0];
    expect(mcp?.env?.TOKEN).toBe("sk-secret-123");
    expect(mcp?.url).toContain("api.example.com");
  });

  it("splitVariables separates plain and secret, creates OWA_VAR_ env entries", () => {
    const { plain, secrets, secretEnv } = splitVariables(baseCfg.variables, {
      API_KEY: "sk-secret",
      BASE_URL: "example.com",
    });

    expect(plain).toEqual({ BASE_URL: "example.com" });
    expect(secrets).toEqual({ API_KEY: "sk-secret" });
    expect(secretEnv).toEqual({ OWA_VAR_API_KEY: "sk-secret" });
  });

  it("checkRequiredVariables reports missing required variables", () => {
    expect(checkRequiredVariables(baseCfg.variables, {})).toEqual(["API_KEY", "BASE_URL"]);
    expect(checkRequiredVariables(baseCfg.variables, { API_KEY: "k", BASE_URL: "u" })).toEqual([]);
    expect(checkRequiredVariables(baseCfg.variables, { API_KEY: "k" })).toEqual(["BASE_URL"]);
    expect(checkRequiredVariables(undefined, {})).toEqual([]);
  });

  it("plain variables are substituted in systemPrompt", () => {
    const cfg: AgentConfig = {
      systemPrompt: "Say {{GREETING}} to the user",
      model: "sonnet",
      maxTurns: 5,
      variables: [{ name: "GREETING", description: "问候语", required: false, secret: false }],
    };
    const spec = buildSpec(cfg, ctx, {
      resolvedVariables: { GREETING: "Hello!" },
    });
    expect(spec.systemPrompt).toContain("Hello!");
    expect(spec.systemPrompt).not.toContain("{{GREETING}}");
  });

  it("no variables defined means no substitution even with resolvedVariables", () => {
    const cfg: AgentConfig = { systemPrompt: "{{FOO}} bar", model: "sonnet", maxTurns: 5 };
    const spec = buildSpec(cfg, ctx, { resolvedVariables: { FOO: "replaced" } });
    expect(spec.systemPrompt).toBe("{{FOO}} bar");
  });
});
