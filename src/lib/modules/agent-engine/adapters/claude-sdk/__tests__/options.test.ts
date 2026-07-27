import { aliasEnv, buildSdkOptions } from "@/lib/modules/agent-engine/adapters/claude-sdk/options";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

const ctx: RunContext = {
  sessionId: "s1",
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
    expect(o.permissionMode).toBe("default");
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

/**
 * transcript 的保留期。
 *
 * SDK 默认 30 天就把 ~/.claude/projects 下的 jsonl 删掉(subagents.md:582)。
 * 后果有两层:会话历史整体消失;更隐蔽的是 resume 会【静默开一个新会话而不报错】
 * (sessions.md:255),表现成"助手突然失忆",日志里干干净净。
 */
describe("transcript 保留期", () => {
  it("显式设置 cleanupPeriodDays,不吃 30 天的默认值", () => {
    const s = buildSdkOptions(specOf(), ctx, deps()).settings as { cleanupPeriodDays?: number };
    expect(s?.cleanupPeriodDays).toBeDefined();
    expect(s?.cleanupPeriodDays ?? 0).toBeGreaterThan(30);
  });

  // sandbox 与 settings 在 SDK 内部会合并成一个 --settings 参数。
  // 实测两者能共存(合并后 cleanupPeriodDays 仍在),但这依赖 SDK 的合并实现,
  // 值得钉住:哪天它改成"有 sandbox 就丢弃 settings",这里先红。
  it("与沙箱设置并存时仍然保留", () => {
    const o = buildSdkOptions(specOf(), ctx, { ...deps(), sandboxEnabled: true });
    const s = o.settings as { cleanupPeriodDays?: number };
    expect(s?.cleanupPeriodDays ?? 0).toBeGreaterThan(30);
    expect(o.sandbox).toBeDefined();
  });
});

/**
 * 围栏挂在 PreToolUse hook 上,不是 canUseTool。
 *
 * 【为什么换】实测 SDK 会发 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED 告警:
 *   "canUseTool will not be invoked for: Bash. Bare allowedTools entries
 *    auto-approve the whole tool before the callback is consulted."
 * 也就是说,只要助手配了工具白名单(裸名),路径守卫和人工审批就【双双静默失效】——
 * 一个本意是收紧权限的配置,反而把围栏拆了。
 * 官方给的正解是 PreToolUse hook:它在所有权限步骤之前跑,连 bypassPermissions 都拦得住。
 */
describe("PreToolUse 围栏接入 SDK options", () => {
  interface HookOutput {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  }
  type Hook = (
    input: Record<string, unknown>,
    toolUseId: string | undefined,
    ctxArg: { signal?: AbortSignal },
  ) => Promise<HookOutput>;

  /** 取出 hook 并包成 (tool, input) → 决策,方便断言。 */
  function gateOf(o: Record<string, unknown> = buildSdkOptions(specOf(), ctx, deps())) {
    const matchers = (o.hooks as { PreToolUse?: { hooks: Hook[] }[] }).PreToolUse;
    if (!matchers?.[0]?.hooks?.[0]) throw new Error("PreToolUse hook 没接上");
    const hook = matchers[0].hooks[0];
    return async (tool: string, input: Record<string, unknown>) => {
      const out = await hook(
        { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input },
        "tu_1",
        {},
      );
      const d = out.hookSpecificOutput?.permissionDecision;
      return { denied: d === "deny", reason: out.hookSpecificOutput?.permissionDecisionReason };
    };
  }

  it("沙箱关闭时围栏依然接上 —— 本地开发也有围栏", () => {
    expect(typeof gateOf()).toBe("function");
  });

  // 省略 matcher 的语义是"匹配该事件的每次出现"。这里必须覆盖【所有】工具:
  // 只要漏掉一个,那个工具就绕过了路径守卫。
  it("不设 matcher —— 围栏覆盖每一次工具调用", () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    const m = (o.hooks as { PreToolUse: Record<string, unknown>[] }).PreToolUse[0];
    expect(m?.matcher).toBeUndefined();
    expect(m).toBeDefined();
  });

  // hook 的 timeout 默认只有 60 秒,而人工审批要等真人,超时上限是 10 分钟。
  // 不显式放宽的话,等人的审批会先被 hook 超时打断 —— 表现为"审批还没点就失败了"。
  it("timeout 必须长于人工审批的超时上限", () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    const m = (o.hooks as { PreToolUse: { timeout?: number }[] }).PreToolUse[0];
    expect(m?.timeout).toBeDefined();
    expect(m?.timeout ?? 0).toBeGreaterThan(10 * 60);
  });

  it("工作空间内写入放行", async () => {
    expect((await gateOf()("Write", { file_path: "/ws/s1/a.txt" })).denied).toBe(false);
  });

  it("越界写入被拒并带出原因", async () => {
    const r = await gateOf()("Write", { file_path: "/Users/someone/escape.txt" });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/工作空间之外/);
  });

  it("共享 HOME 与临时目录放行(工具缓存需要)", async () => {
    expect((await gateOf()("Write", { file_path: "/data/.agent-home/.cache/x" })).denied).toBe(
      false,
    );
    expect((await gateOf()("Write", { file_path: "/tmp/scratch" })).denied).toBe(false);
  });

  it("Bash 不被守卫拦(交给内核沙箱)", async () => {
    expect((await gateOf()("Bash", { command: "rm -rf /" })).denied).toBe(false);
  });

  it("配了审批规则但没给审批钩子时,规则被忽略而非卡住", async () => {
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, deps());
    expect((await gateOf(o)("Bash", { command: "ls" })).denied).toBe(false);
  });

  it("需审批时挂起等裁决:批准则放行", async () => {
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, {
      ...deps(),
      requestApproval: async () => ({ approved: true }),
    });
    expect((await gateOf(o)("Bash", { command: "rm -rf x" })).denied).toBe(false);
  });

  it("需审批时拒绝则不执行,并带出说明", async () => {
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, {
      ...deps(),
      requestApproval: async () => ({ approved: false, message: "审批超时,已自动拒绝" }),
    });
    const r = await gateOf(o)("Bash", { command: "rm -rf x" });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/超时/);
  });

  // 【不能问两遍】决策只在 hook 里做一次。若 canUseTool 也跑一遍审批逻辑,
  // 同一次工具调用会弹出两条待审 —— 用户点完第一条,还要再点一条一模一样的。
  it("canUseTool 不再重复决策,只做无人可问时的默认放行", async () => {
    let asked = 0;
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, {
      ...deps(),
      requestApproval: async () => {
        asked++;
        return { approved: true };
      },
    });
    await gateOf(o)("Bash", { command: "rm -rf x" });
    const canUseTool = o.canUseTool as unknown as (
      t: string,
      i: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    const r = await canUseTool("Bash", { command: "rm -rf x" });
    expect(r.behavior).toBe("allow");
    expect(asked).toBe(1); // hook 问过一次,canUseTool 不再问
  });

  // 审批通道本身出故障时的行为,曾经完全没被覆盖。
  // 当时 `await deps.requestApproval(...)` 没有 try:promise 被 reject,
  // 代码根本走不到 deny 分支,fail-closed 路径被整个跳过 ——
  // 一个需要人确认的危险操作,不能因为审批通道挂了就变成"没人拦"。
  it("【fail-closed 回归】审批通道抛异常时必须拒绝,不能放行", async () => {
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, {
      ...deps(),
      requestApproval: async () => {
        throw new Error("redis 不可达");
      },
    });
    const r = await gateOf(o)("Bash", { command: "rm -rf /important" });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/审批通道不可用/);
  });

  it("审批通道故障不影响无需审批的工具", async () => {
    const o = buildSdkOptions(specOf({ approvalRules: { tools: ["Bash"] } }), ctx, {
      ...deps(),
      requestApproval: async () => {
        throw new Error("redis 不可达");
      },
    });
    expect((await gateOf(o)("Read", { file_path: "/etc/hosts" })).denied).toBe(false);
  });

  it("守卫优先于审批 —— 越界操作不浪费人的注意力去审", async () => {
    const spy = vi.fn(async () => ({ approved: true }));
    const o = buildSdkOptions(specOf({ approvalRules: { all: true } }), ctx, {
      ...deps(),
      requestApproval: spy,
    });
    expect((await gateOf(o)("Write", { file_path: "/etc/passwd" })).denied).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
