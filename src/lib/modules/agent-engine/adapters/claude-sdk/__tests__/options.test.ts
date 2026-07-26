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

const SLOTS = { fable: "m-fable", opus: "m-opus", sonnet: "m-sonnet", haiku: "m-haiku" };

const deps = () => ({
  sharedHome: "/data/.agent-home",
  abort: new AbortController(),
  slots: SLOTS,
  sandboxEnabled: false,
});

function specOf(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    systemPrompt: "p",
    model: { alias: "sonnet" },
    limits: { maxTurns: 30, effort: "medium" },
    ...over,
  };
}

describe("aliasEnv", () => {
  it("把别名槽填成网关给的真实 modelId", () => {
    const env = aliasEnv({ baseUrl: "https://gw", key: "sk-x" }, SLOTS);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("m-opus");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m-sonnet");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("m-haiku");
  });

  it("小快模型槽复用 haiku", () => {
    expect(aliasEnv({ baseUrl: "b", key: "k" }, SLOTS).ANTHROPIC_SMALL_FAST_MODEL).toBe("m-haiku");
  });

  it("清空 AUTH_TOKEN,防宿主残留抢占 API_KEY", () => {
    expect(aliasEnv({ baseUrl: "b", key: "k" }, SLOTS).ANTHROPIC_AUTH_TOKEN).toBe("");
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

  it("options.model 传别名,由 env 槽映射到真实 modelId", () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    expect(o.model).toBe("sonnet");
    expect((o.env as Record<string, string>).ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m-sonnet");
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

describe("执行隔离进入 SDK options", () => {
  const withSandbox = () => ({
    sharedHome: "/data/.agent-home",
    abort: new AbortController(),
    slots: SLOTS,
    sandboxEnabled: true,
  });

  it("启用时把工作目录写进沙箱可写白名单", () => {
    const o = buildSdkOptions(specOf(), ctx, withSandbox());
    const fs = (o.sandbox as { filesystem: { allowWrite: string[] } }).filesystem;
    expect(fs.allowWrite).toContain("/ws/s1");
  });

  it("启用时沙箱起不来即硬失败", () => {
    const o = buildSdkOptions(specOf(), ctx, withSandbox());
    expect((o.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(true);
  });

  it("关闭时不传 sandbox,但仍给宿主侧工具 deny 规则", () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    expect(o.sandbox).toBeUndefined();
    expect(o.disallowedTools).toEqual(expect.arrayContaining([expect.stringContaining("Write(")]));
  });

  it("逃生舱可覆盖沙箱设置(留给特殊业务)", () => {
    const o = buildSdkOptions(specOf({ escapeHatch: { sandbox: undefined } }), ctx, withSandbox());
    expect(o.sandbox).toBeUndefined();
  });
});
