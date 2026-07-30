import {
  aliasEnv,
  buildSdkOptions,
  claudeConfigDir,
} from "@/lib/modules/agent-engine/adapters/claude-sdk/options";
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
  allowStdioMcp: false,
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

  /**
   * SDK 的 McpHttpServerConfig.url 是必填 string,而 McpDef.url 可选。
   * 不在这里挡住,就会把 url: undefined 透传进 SDK —— 报错点被推迟到运行时连接阶段,
   * 错误信息里也看不出是哪个服务器配漏了。
   */
  it("http MCP 缺 url 时立即报错,不把 undefined 透传给 SDK", () => {
    expect(() =>
      buildSdkOptions(specOf({ mcpServers: [{ name: "remote", type: "http" }] }), ctx, deps()),
    ).toThrow(/http MCP.*remote.*url/);
  });

  it("http MCP 的 url 是空白串也算缺失", () => {
    expect(() =>
      buildSdkOptions(
        specOf({ mcpServers: [{ name: "remote", type: "http", url: "   " }] }),
        ctx,
        deps(),
      ),
    ).toThrow(/http MCP.*remote.*url/);
  });

  it("stdio MCP 默认拒绝,不能启动宿主任意命令", () => {
    expect(() =>
      buildSdkOptions(
        specOf({
          mcpServers: [{ name: "local", type: "stdio", command: "npx", args: ["-y", "pkg"] }],
        }),
        ctx,
        deps(),
      ),
    ).toThrow(/stdio MCP.*未启用|OWA_ALLOW_STDIO_MCP/);
  });

  it("平台开启后 stdio MCP 按 SDK 形状传递 command/args/env", () => {
    const o = buildSdkOptions(
      specOf({
        mcpServers: [
          {
            name: "local",
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
            env: { TOKEN: "secret" },
          },
        ],
      }),
      ctx,
      { ...deps(), allowStdioMcp: true },
    );
    expect(o.mcpServers).toEqual({
      local: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: { TOKEN: "secret" },
      },
    });
  });

  it("escapeHatch 不能在平台关闭时偷塞 stdio MCP", () => {
    expect(() =>
      buildSdkOptions(
        specOf({
          escapeHatch: {
            mcpServers: { local: { type: "stdio", command: "sh", args: ["-c", "id"] } },
          },
        }),
        ctx,
        deps(),
      ),
    ).toThrow(/stdio MCP.*未启用|OWA_ALLOW_STDIO_MCP/);
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
    allowStdioMcp: false,
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
 * 子代理的形状。
 *
 * SDK 要的是 Record<string, AgentDefinition>,而此前传的是数组 —— 且 SDK 源码里
 * 这个字段是【原样透传不校验】的(`agents: this.initConfig?.agents`,
 * 对照隔壁 skills 还做了 Array.isArray 检查)。所以传错形状不会报错,
 * 只是子代理静默不生效:构建器里配了、存下来了、界面也显示着。
 */
describe("子代理传给 SDK 的形状", () => {
  const agentsOf = (subagents: AgentSpec["subagents"]) =>
    buildSdkOptions(specOf({ subagents }), ctx, deps()).agents as
      | Record<string, { description?: string; prompt?: string; background?: boolean }>
      | undefined;

  it("是对象而非数组 —— 数组会让 agent 名变成下标", () => {
    const a = agentsOf([
      { name: "reviewer", description: "需要审阅代码时", prompt: "你是审阅者", background: false },
    ]);
    expect(Array.isArray(a)).toBe(false);
    expect(Object.keys(a ?? {})).toEqual(["reviewer"]);
    expect(a?.reviewer?.prompt).toBe("你是审阅者");
    expect(a?.reviewer?.description).toBe("需要审阅代码时");
  });

  // description 在 SDK 侧是必需字段。老配置里没有它,不能因此整个子代理失效。
  it("老配置缺 description 时用名字兜底,而不是漏掉必需字段", () => {
    const a = agentsOf([{ name: "reviewer", prompt: "p", background: false }]);
    expect(a?.reviewer?.description).toBeTruthy();
  });

  it("平台强制同步执行 —— background 恒为 false", () => {
    const a = agentsOf([{ name: "r", prompt: "p", background: false }]);
    expect(a?.r?.background).toBe(false);
  });

  it("没配子代理时不传该字段", () => {
    expect(agentsOf(undefined)).toBeUndefined();
    expect(agentsOf([])).toBeUndefined();
  });
});

/**
 * 多租户隔离:一个租户的东西不能漏进另一个租户的会话。
 * 四条建议里 cwd 早就按会话隔离了,这里是其余三条。
 */
describe("多租户隔离", () => {
  const envOf = () =>
    buildSdkOptions(specOf(), ctx, deps()).env as Record<string, string | undefined>;

  // 【显式而非搭便车】以前只改 HOME,靠 SDK 自己推 $HOME/.claude。
  // 能用,但读历史的一方得再推一遍同样的规则,推错了是静默读不到 ——
  // 实测主进程不设它时 getSessionMessages 返回 0 条,还不报错。
  it("显式指定 CLAUDE_CONFIG_DIR,与 claudeConfigDir() 同源", () => {
    expect(envOf().CLAUDE_CONFIG_DIR).toBe(claudeConfigDir("/data/.agent-home"));
    expect(envOf().CLAUDE_CONFIG_DIR).toBe("/data/.agent-home/.claude");
  });

  // HOME 仍然要给:pip/npm/matplotlib 都往 ~/.cache 写,
  // 容器里运行用户的 HOME 常是不可写的 /nonexistent。
  it("HOME 照常给,和 CLAUDE_CONFIG_DIR 各司其职", () => {
    expect(envOf().HOME).toBe("/data/.agent-home");
  });

  // 宿主机上任何一份 CLAUDE.md / settings.json 都会无差别混进每个租户的会话。
  // 本仓库根目录就有 CLAUDE.md —— 开发机上这条尤其明显。
  it("不加载宿主的文件系统设置", () => {
    expect(buildSdkOptions(specOf(), ctx, deps()).settingSources).toEqual([]);
  });

  // 文档明说自动记忆"无论 settingSources 如何"都会加载 —— 上一条关不掉它。
  it("关掉自动记忆(settingSources 关不掉的那条通道)", () => {
    expect(envOf().CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

/**
 * 权限模式:按场景选,不是安全等级。
 * web 对话有人盯着 → default + 审批;接口调用无人值守 → bypassPermissions。
 */
describe("权限模式", () => {
  it("不配时默认 default", () => {
    expect(buildSdkOptions(specOf(), ctx, deps()).permissionMode).toBe("default");
  });

  it("六种模式都能传下去", () => {
    for (const mode of [
      "default",
      "dontAsk",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "auto",
    ] as const) {
      expect(buildSdkOptions(specOf({ permissionMode: mode }), ctx, deps()).permissionMode).toBe(
        mode,
      );
    }
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

  /**
   * 工具白名单也必须由 hook 兜住,不能只靠 allowedTools。
   *
   * 文档原文:"allowed_tools 不约束 bypassPermissions。设置 allowed_tools=["Read"]
   * 与 permission_mode="bypassPermissions" 一起【仍然批准每个工具,包括 Bash、
   * Write 和 Edit】。" —— 也就是说界面上那句"填了就只允许这些工具"在该模式下是假的。
   *
   * 文档建议改用 disallowedTools,但那要穷举全部工具名,而且是 fail-open:
   * SDK 以后新增一个工具,它不在黑名单里就被放行,白名单静默漏了一个口子。
   * 放在 hook 里做正向白名单则是 fail-closed —— 不认识的工具一律拒。
   */
  it("配了白名单 → 名单外的工具被拒(不依赖 allowedTools)", async () => {
    const o = buildSdkOptions(specOf({ tools: [{ name: "Read" }] }), ctx, deps());
    expect((await gateOf(o)("Read", { file_path: "/ws/s1/a.txt" })).denied).toBe(false);
    const r = await gateOf(o)("Bash", { command: "ls" });
    expect(r.denied).toBe(true);
    expect(r.reason).toMatch(/不在.*白名单|未授权/);
  });

  it("【关键】bypassPermissions 下白名单依然生效 —— 这正是 allowedTools 失效的模式", async () => {
    const o = buildSdkOptions(
      specOf({ tools: [{ name: "Read" }], permissionMode: "bypassPermissions" }),
      ctx,
      deps(),
    );
    expect(o.permissionMode).toBe("bypassPermissions");
    expect((await gateOf(o)("Bash", { command: "rm -rf /" })).denied).toBe(true);
  });

  it("不配白名单 = 不限制,任何工具都过", async () => {
    const o = buildSdkOptions(specOf(), ctx, deps());
    expect((await gateOf(o)("Bash", { command: "ls" })).denied).toBe(false);
    expect((await gateOf(o)("WebFetch", { url: "https://x" })).denied).toBe(false);
  });

  // 白名单是 fail-closed 的直接体现:没见过的工具名一律拒,而不是放行。
  it("白名单里没有的新工具 —— 拒绝而非放行", async () => {
    const o = buildSdkOptions(specOf({ tools: [{ name: "Read" }] }), ctx, deps());
    expect((await gateOf(o)("SomeFutureToolFromNewerSdk", {})).denied).toBe(true);
  });

  /**
   * MCP 工具必须能用通配符授权。
   *
   * 一个 MCP 服务器动辄几十个工具(mcp__github__get_issue、mcp__github__create_pr…),
   * 让用户逐个列出来不现实 —— 文档里每个 MCP 示例给的也都是
   * `allowedTools: ["mcp__filesystem__*"]` 这种带星号的写法。
   * 白名单若只做精确匹配,「工具白名单 + MCP」这个组合就完全不可用。
   */
  it("mcp__server__* 授权该服务器的全部工具", async () => {
    const o = buildSdkOptions(specOf({ tools: [{ name: "mcp__github__*" }] }), ctx, deps());
    expect((await gateOf(o)("mcp__github__get_issue", {})).denied).toBe(false);
    expect((await gateOf(o)("mcp__github__create_pr", {})).denied).toBe(false);
    // 别的服务器不在授权范围内
    expect((await gateOf(o)("mcp__gitlab__get_issue", {})).denied).toBe(true);
  });

  it("前缀通配只匹配前缀,不是「含有即可」", async () => {
    const o = buildSdkOptions(specOf({ tools: [{ name: "mcp__fs__read*" }] }), ctx, deps());
    expect((await gateOf(o)("mcp__fs__read_file", {})).denied).toBe(false);
    expect((await gateOf(o)("mcp__fs__write_file", {})).denied).toBe(true);
  });

  it("裸名仍是精确匹配 —— Read 不会顺带放行 ReadMcpResourceTool", async () => {
    const o = buildSdkOptions(specOf({ tools: [{ name: "Read" }] }), ctx, deps());
    expect((await gateOf(o)("Read", { file_path: "/ws/s1/a" })).denied).toBe(false);
    expect((await gateOf(o)("ReadMcpResourceTool", {})).denied).toBe(true);
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
