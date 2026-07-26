import { aliasEnv, buildSdkOptions } from "@/lib/modules/agent-engine/adapters/claude-sdk/options";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const ctx: RunContext = {
  workspaceDir: "/ws/s1",
  prompt: "go",
  resumeSessionId: "sess_9",
  credentials: { baseUrl: "https://gw", key: "sk-real" },
  env: { FOO: "bar" },
};

const deps = () => ({ sharedHome: "/data/.agent-home", abort: new AbortController() });

function specOf(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    systemPrompt: "p",
    model: { alias: "sonnet" },
    limits: { maxTurns: 30, effort: "medium" },
    ...over,
  };
}

describe("aliasEnv", () => {
  it("注入 base/key 与三个别名槽", () => {
    const env = aliasEnv({ baseUrl: "https://gw", key: "sk-x" }, "opus");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("opus");
  });

  it("清空 AUTH_TOKEN,防宿主残留抢占 API_KEY", () => {
    expect(aliasEnv({ baseUrl: "b", key: "k" }, "sonnet").ANTHROPIC_AUTH_TOKEN).toBe("");
  });
});

describe("buildSdkOptions", () => {
  it("cwd 锁到会话工作目录,model 用别名,resume 透传", () => {
    const d = deps();
    const o = buildSdkOptions(specOf(), ctx, d);
    expect(o.cwd).toBe("/ws/s1");
    expect(o.model).toBe("sonnet");
    expect(o.resume).toBe("sess_9");
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.abortController).toBe(d.abort);
  });

  it("env 合并用户 env + 凭证 + 共享 HOME", () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    const env = o.env as Record<string, string>;
    expect(env.FOO).toBe("bar");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-real");
    expect(env.HOME).toBe("/data/.agent-home");
  });

  it("无 outputSchema → 不带 outputFormat", () => {
    expect(buildSdkOptions(specOf(), ctx, deps()).outputFormat).toBeUndefined();
  });

  it("有 outputSchema → 启用 json_schema 结构化输出", () => {
    const o = buildSdkOptions(specOf({ outputSchema: { type: "object" } }), ctx, deps());
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
  });

  it("mcpServers 映射为 { name: { type, url } }", () => {
    const o = buildSdkOptions(
      specOf({ mcpServers: [{ name: "fs", type: "http", url: "http://x" }] }),
      ctx,
      deps(),
    );
    expect(o.mcpServers).toEqual({ fs: { type: "http", url: "http://x" } });
  });

  it("无 mcpServers 时不传该字段", () => {
    expect(buildSdkOptions(specOf(), ctx, deps()).mcpServers).toBeUndefined();
  });

  it("逃生舱最后 spread,可覆盖任何默认", () => {
    const o = buildSdkOptions(
      specOf({ escapeHatch: { permissionMode: "default", includePartialMessages: true } }),
      ctx,
      deps(),
    );
    expect(o.permissionMode).toBe("default");
    expect(o.includePartialMessages).toBe(true);
  });
});
