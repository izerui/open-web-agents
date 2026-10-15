import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";
import { buildSdkOptions } from "../options";

describe("variable injection through SDK options to script execution", () => {
  it("script reads OWA_VAR env vars, skill file on disk has no secrets", () => {
    const spec: AgentSpec = {
      systemPrompt: "test",
      model: { alias: "sonnet" },
      limits: { maxTurns: 5 },
      skillPackages: [
        {
          name: "reader",
          description: "Read env",
          files: {
            "SKILL.md":
              "# Reader\nAccess API_KEY via process.env.OWA_VAR_API_KEY\nAccess BASE_URL via process.env.OWA_VAR_BASE_URL",
          },
        },
      ],
      mcpServers: [],
    };

    const ctx: RunContext = {
      sessionId: "test-session",
      runId: "test-run",
      workspaceDir: "/tmp/test-ws",
      prompt: "test",
      env: {
        OWA_VAR_API_KEY: "sk-injected-secret",
        OWA_VAR_BASE_URL: "injected.example.com",
      },
      credentials: { baseUrl: "http://localhost:1", key: "test-key" },
      unattended: false,
      approvalPolicy: "ask",
    };

    const deps = {
      sharedHome: tmpdir(),
      hostHome: tmpdir(),
      abort: new AbortController(),
      slots: { sonnet: "claude-sonnet-4-20250514", fable: "fable", opus: "opus", haiku: "haiku" },
      allowStdioMcp: false,
      sandboxEnabled: false,
    };

    const options = buildSdkOptions(spec, ctx, deps);
    const sdkEnv = options.env as Record<string, string>;

    // Env flows through to SDK options
    expect(sdkEnv.OWA_VAR_API_KEY).toBe("sk-injected-secret");
    expect(sdkEnv.OWA_VAR_BASE_URL).toBe("injected.example.com");

    // Write skill file to temp dir and verify it has no secrets
    const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
    const skillPath = join(dir, "SKILL.md");
    const skillContent = spec.skillPackages?.[0]?.files["SKILL.md"] ?? "";
    writeFileSync(skillPath, skillContent);

    const diskContent = execSync(`cat ${skillPath}`, { encoding: "utf-8" });
    expect(diskContent).toContain("OWA_VAR_API_KEY");
    expect(diskContent).not.toContain("sk-injected-secret");

    // Execute a script that reads the env vars — simulating what a skill script would do
    const script =
      "console.log(JSON.stringify({key:process.env.OWA_VAR_API_KEY,url:process.env.OWA_VAR_BASE_URL}))";
    const result = execSync(`node -e "${script}"`, {
      encoding: "utf-8",
      env: { ...process.env, ...sdkEnv },
    });
    const parsed = JSON.parse(result.trim());
    expect(parsed.key).toBe("sk-injected-secret");
    expect(parsed.url).toBe("injected.example.com");

    // Cleanup
    execSync(`rm -rf ${dir}`);
  });
});
