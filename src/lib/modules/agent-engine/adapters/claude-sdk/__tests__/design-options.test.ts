import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ARCHITECT_CONFIG } from "@/lib/modules/agent/domain/architect";
import { DRAFT_FILE } from "@/lib/modules/agent/domain/design";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { expect, it } from "vitest";
import { buildSdkOptions } from "../options";

it("platform design can only edit its draft, not skill scripts, secrets, MCP or shell", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-design-guard-"));
  try {
    await fs.writeFile(path.join(root, DRAFT_FILE), "{}");
    const spec: AgentSpec = {
      systemPrompt: ARCHITECT_CONFIG.systemPrompt,
      model: { alias: "opus" },
      limits: { maxTurns: 30 },
      tools: ARCHITECT_CONFIG.tools,
    };
    const ctx: RunContext = {
      sessionId: "design-test",
      designMode: true,
      workspaceDir: root,
      prompt: "edit",
      credentials: { baseUrl: "https://platform.invalid", key: "fake" },
      env: {},
    };
    const options = buildSdkOptions(spec, ctx, {
      sharedHome: path.join(root, "home"),
      hostHome: "/host",
      abort: new AbortController(),
      sandboxEnabled: false,
      allowStdioMcp: false,
      slots: { fable: "f", opus: "o", sonnet: "s", haiku: "h" },
    });
    type Hook = (
      input: Record<string, unknown>,
      id: string,
      context: object,
    ) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
    const hook = (options.hooks as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0]?.hooks[0];
    if (!hook) throw new Error("missing permission hook");
    const allowed = async (name: string, input: unknown) =>
      (
        await hook(
          { hook_event_name: "PreToolUse", tool_name: name, tool_input: input },
          "tool",
          {},
        )
      ).hookSpecificOutput?.permissionDecision !== "deny";
    expect(await allowed("Read", { file_path: DRAFT_FILE })).toBe(true);
    expect(await allowed("Edit", { file_path: path.join(root, DRAFT_FILE) })).toBe(true);
    expect(await allowed("Write", { file_path: DRAFT_FILE, content: "{}" })).toBe(true);
    expect(await allowed("Write", { file_path: "agent/skills/new/script.sh" })).toBe(false);
    expect(await allowed("Read", { file_path: "/host/.env" })).toBe(false);
    expect(await allowed("Read", { file_path: "agent/agent.json" })).toBe(false);
    expect(await allowed("Bash", { command: "echo x" })).toBe(false);
    expect(await allowed("mcp__provider__call", {})).toBe(false);
    await fs.unlink(path.join(root, DRAFT_FILE));
    await fs.writeFile(path.join(root, "other"), "secret");
    await fs.symlink(path.join(root, "other"), path.join(root, DRAFT_FILE));
    expect(await allowed("Read", { file_path: DRAFT_FILE })).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
