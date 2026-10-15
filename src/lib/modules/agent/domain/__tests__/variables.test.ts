import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import { describe, expect, it } from "vitest";
import { buildSpec, checkRequiredVariables, splitVariables } from "../build-spec";

const ctx = {
  sessionId: "s1",
  runId: "r1",
  workspaceDir: "/tmp/ws",
  prompt: "test",
  env: {} as Record<string, string>,
  credentials: { baseUrl: "http://localhost", key: "k" },
};

const baseCfg: AgentConfig = {
  systemPrompt: "You have access to {{API_KEY}} and {{BASE_URL}}",
  model: "sonnet",
  maxTurns: 10,
  mcpServers: [
    { type: "http", name: "web-api", url: "https://{{BASE_URL}}/v1?token={{API_KEY}}" },
    {
      type: "stdio",
      name: "local-tool",
      command: "node",
      args: ["tool.js"],
      env: { API_KEY: "{{API_KEY}}", BASE_URL: "{{BASE_URL}}" },
    },
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

  it("secret and plain variables ARE injected into MCP configs", () => {
    const spec = buildSpec(baseCfg, ctx, {
      resolvedVariables: { API_KEY: "sk-secret-123", BASE_URL: "api.example.com" },
    });

    const httpMcp = spec.mcpServers?.find((m) => m.name === "web-api");
    expect(httpMcp?.url).toBe("https://api.example.com/v1?token=sk-secret-123");

    const stdioMcp = spec.mcpServers?.find((m) => m.name === "local-tool");
    expect(stdioMcp?.env?.API_KEY).toBe("sk-secret-123");
    expect(stdioMcp?.env?.BASE_URL).toBe("api.example.com");
  });

  it("splitVariables puts all declared vars in secretEnv with OWA_VAR_ prefix", () => {
    const { plain, secrets, secretEnv } = splitVariables(baseCfg.variables, {
      API_KEY: "sk-secret",
      BASE_URL: "example.com",
    });

    expect(plain).toEqual({ BASE_URL: "example.com" });
    expect(secrets).toEqual({ API_KEY: "sk-secret" });
    expect(secretEnv).toEqual({
      OWA_VAR_API_KEY: "sk-secret",
      OWA_VAR_BASE_URL: "example.com",
    });
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

  it("deleted secret definition does not leak old value into prompt or environment", () => {
    const cfg: AgentConfig = {
      systemPrompt: "hello {{PLAIN_VAR}}",
      model: "sonnet",
      maxTurns: 5,
      variables: [{ name: "PLAIN_VAR", description: "保留的", required: false, secret: false }],
    };
    const staleValues = { PLAIN_VAR: "visible", OLD_SECRET: "leaked-key" };
    const { plain, secrets, secretEnv } = splitVariables(cfg.variables, staleValues);
    expect(plain).toEqual({ PLAIN_VAR: "visible" });
    expect(secrets).toEqual({});
    expect(Object.keys(secretEnv)).toEqual(["OWA_VAR_PLAIN_VAR"]);
    expect(Object.values(secretEnv)).not.toContain("leaked-key");

    const spec = buildSpec(cfg, ctx, { resolvedVariables: staleValues });
    expect(spec.systemPrompt).not.toContain("leaked-key");
    expect(spec.systemPrompt).toContain("visible");
  });

  it("skill scripts can read both plain and secret variables via process.env.OWA_VAR_*", () => {
    const { secretEnv } = splitVariables(baseCfg.variables, {
      API_KEY: "sk-secret",
      BASE_URL: "example.com",
    });
    expect(secretEnv.OWA_VAR_API_KEY).toBe("sk-secret");
    expect(secretEnv.OWA_VAR_BASE_URL).toBe("example.com");
  });

  it("AI-generated skill using OWA_VAR env gets values, file has no secrets", () => {
    const cfg: AgentConfig = {
      systemPrompt: "Serve at {{BASE_URL}}",
      model: "sonnet",
      maxTurns: 5,
      skillPackages: [
        {
          name: "fetcher",
          description: "Fetch data",
          files: {
            "SKILL.md":
              "# Fetcher\nUse process.env.OWA_VAR_API_KEY to authenticate.\nCall process.env.OWA_VAR_BASE_URL for the endpoint.",
          },
        },
      ],
      mcpServers: [{ type: "http", name: "api", url: "https://{{BASE_URL}}/v1?token={{API_KEY}}" }],
      variables: [
        { name: "API_KEY", description: "密钥", required: true, secret: true },
        { name: "BASE_URL", description: "地址", required: true, secret: false },
      ],
    };

    const values = { API_KEY: "sk-real-secret", BASE_URL: "api.example.com" };
    const spec = buildSpec(cfg, ctx, { resolvedVariables: values });
    const { secretEnv } = splitVariables(cfg.variables, values);

    // Skill file doesn't contain actual secrets
    const skillContent = spec.skillPackages?.[0]?.files["SKILL.md"] ?? "";
    expect(skillContent).not.toContain("sk-real-secret");
    expect(skillContent).toContain("OWA_VAR_API_KEY");
    expect(skillContent).toContain("OWA_VAR_BASE_URL");

    // Environment variables carry actual values for skill scripts
    expect(secretEnv.OWA_VAR_API_KEY).toBe("sk-real-secret");
    expect(secretEnv.OWA_VAR_BASE_URL).toBe("api.example.com");

    // MCP URL is substituted with actual values
    expect(spec.mcpServers?.[0]?.url).toBe("https://api.example.com/v1?token=sk-real-secret");

    // System prompt has plain var substituted but not secret
    expect(spec.systemPrompt).toContain("api.example.com");
    expect(spec.systemPrompt).not.toContain("sk-real-secret");
  });
});
