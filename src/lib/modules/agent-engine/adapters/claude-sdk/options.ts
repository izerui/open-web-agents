// SDK 选项组装:域内 AgentSpec + RunContext → claude-agent-sdk query 的 options。
// 属 adapter 层,但刻意写成【不 import SDK】的纯函数,便于单测。

import path from "node:path";
import { describeToolCall, needsApproval } from "@/lib/modules/agent-engine/domain/approval-rules";
import { materializeSandbox } from "@/lib/modules/agent-engine/domain/sandbox";
import { guardToolUse } from "@/lib/modules/agent-engine/domain/tool-guard";
import type { ModelSlots } from "@/lib/modules/model-gateway/ports";
import type { AgentSpec, ResolvedCredentials, RunContext } from "@/lib/shared";

/**
 * agent 子进程的 ANTHROPIC_* 环境。
 *
 * 别名槽当"角色槽":options.model 传别名(如 "sonnet"),SDK 通过 ANTHROPIC_DEFAULT_*_MODEL
 * 把它换成真实 modelId 再发给网关 —— 平台只认别名,真实模型由 ModelGatewayPort 决定。
 * ANTHROPIC_AUTH_TOKEN 置空:防宿主环境残留的 token 抢占 API_KEY。
 */
export function aliasEnv(creds: ResolvedCredentials, slots: ModelSlots): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: creds.baseUrl,
    ANTHROPIC_API_KEY: creds.key,
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: slots.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: slots.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: slots.haiku,
    ANTHROPIC_SMALL_FAST_MODEL: slots.haiku,
  };
}

/**
 * PreToolUse hook 的超时(秒)。
 *
 * 必须大于人工审批的超时上限(container.ts 的 APPROVAL_TIMEOUT_MS,10 分钟),
 * 否则 hook 会先于审批超时而中止 —— 用户还没来得及点,这次调用就已经失败了。
 * 多给 1 分钟余量,让"审批自己超时"成为唯一的收场方式,行为才可预期。
 */
const APPROVAL_HOOK_TIMEOUT_SEC = 11 * 60;

/**
 * transcript 保留天数。
 *
 * 【为什么必须显式设】SDK 默认 30 天就清掉 projects 下的 jsonl。后果有两层:
 * 一是会话历史整体消失;二是更隐蔽的 —— resume 找不到文件时【静默开一个新会话
 * 而不报错】,表现成"智能体突然失忆",日志里什么异常都没有。
 *
 * 【为什么是一年,不是永久】永久保留等于让磁盘无上限增长,而这是个自托管单机产品,
 * 磁盘满了会连带把队列和数据库一起拖垮 —— 那比丢历史严重得多。
 * 一年足够覆盖审计与回溯需求,量级也可控(实测单份 transcript 最大 388KB)。
 */
const TRANSCRIPT_RETENTION_DAYS = 365;

/**
 * SDK 配置目录(transcript、全局配置的落点)。
 *
 * 【单独导出的理由】写入方(跑 agent)和读取方(读会话历史)必须指向同一个目录,
 * 而这个约定一旦在两处各推一遍,推错了不会报错 —— 只是历史静默读不到
 * (实测:主进程不设 CLAUDE_CONFIG_DIR 时 getSessionMessages 返回 0 条,无异常)。
 * 所以它只能有一个来源。
 */
export function claudeConfigDir(sharedHome: string): string {
  return path.join(sharedHome, ".claude");
}

/**
 * SubagentDef[] → SDK 的 `Record<string, AgentDefinition>`。
 *
 * 【为什么必须转】SDK 要的是以代理名为键的对象,而域内存的是数组。
 * 直接把数组传过去不会报错 —— SDK 源码里这个字段是原样透传、不做任何校验的
 * (`agents: this.initConfig?.agents`,对照隔壁 skills 还判了 Array.isArray)。
 * 于是子代理静默不生效:构建器配了、库里存了、界面也显示着,就是不干活。
 *
 * `description` 在 SDK 侧是必需字段,含义是【何时】该用这个子代理 ——
 * 主 agent 就是靠它决定要不要把子任务交出去。缺了就用名字兜底,
 * 至少让字段合法;写得好不好是配置质量问题,不该让整个子代理失效。
 */
function toAgents(spec: AgentSpec): Record<string, unknown> | undefined {
  if (!spec.subagents?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of spec.subagents) {
    if (!s.name) continue;
    out[s.name] = {
      description: s.description?.trim() || `处理与「${s.name}」相关的子任务`,
      prompt: s.prompt,
      // 平台强制同步执行:后台跑的子代理没法纳入过程监控
      background: false,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 工具名是否命中白名单条目。
 *
 * 【为什么必须支持通配】一个 MCP 服务器动辄几十个工具
 * (mcp__github__get_issue、mcp__github__create_pr…),让用户逐个列出来不现实。
 * 文档里每个 MCP 示例给的也都是 `allowedTools: ["mcp__filesystem__*"]`。
 * 只做精确匹配的话,「工具白名单 + MCP」这个组合直接不可用。
 *
 * 【只支持后缀 `*`,不做正则】白名单是安全边界,匹配规则越简单越不容易误判。
 * 正则里一个没转义的 `.` 就能把 `mcp__a_b` 意外放行给 `mcp__axb`。
 */
function matchesTool(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

function stdioDisabledError(name?: string): Error {
  return new Error(
    `stdio MCP${name ? `「${name}」` : ""}未启用；部署方需显式设置 OWA_ALLOW_STDIO_MCP=1`,
  );
}

function assertStdioMcpAllowed(mcpServers: unknown, allowed: boolean): void {
  if (allowed || !mcpServers || typeof mcpServers !== "object") return;
  for (const [name, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    if (server.type === "stdio" || typeof server.command === "string") {
      throw stdioDisabledError(name);
    }
  }
}

/** McpDef[] → SDK mcpServers 形状。 */
function toMcpServers(
  spec: AgentSpec,
  allowStdioMcp: boolean,
): Record<string, unknown> | undefined {
  if (!spec.mcpServers?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of spec.mcpServers) {
    if (s.type === "http") {
      if (!s.url?.trim()) throw new Error(`http MCP「${s.name}」缺少 url`);
      out[s.name] = { type: "http", url: s.url };
      continue;
    }
    if (!allowStdioMcp) throw stdioDisabledError(s.name);
    if (!s.command?.trim()) throw new Error(`stdio MCP「${s.name}」缺少 command`);
    if (
      s.args !== undefined &&
      (!Array.isArray(s.args) || s.args.some((x) => typeof x !== "string"))
    ) {
      throw new Error(`stdio MCP「${s.name}」的 args 必须是字符串数组`);
    }
    if (
      s.env !== undefined &&
      (typeof s.env !== "object" ||
        s.env === null ||
        Array.isArray(s.env) ||
        Object.values(s.env).some((x) => typeof x !== "string"))
    ) {
      throw new Error(`stdio MCP「${s.name}」的 env 必须是字符串键值对象`);
    }
    out[s.name] = {
      type: "stdio",
      command: s.command,
      args: s.args,
      env: s.env,
    };
  }
  return out;
}

export interface SdkOptionsDeps {
  /** agent 子进程的 HOME:固定共享目录,让工具缓存跨会话复用,且避开容器内不可写的 HOME。 */
  sharedHome: string;
  abort: AbortController;
  /** 别名槽 → 真实 modelId。 */
  slots: ModelSlots;
  /** 是否启用 OS 内核沙箱。 */
  sandboxEnabled: boolean;
  /** 是否允许在宿主机启动 stdio MCP 进程。 */
  allowStdioMcp: boolean;
  /**
   * 人工审批钩子(HITL)。给了才启用审批;不给则审批规则被忽略。
   * 返回 true 放行、false 拒绝 —— 实现方负责超时兜底。
   *
   * signal 必须透传下去:运行被取消/超时中止时,挂着的审批要立刻收场,
   * 否则等待方、定时器与待审记录会一直留到自己的 10 分钟超时
   * (见 approval/ports.ts 的说明)。
   */
  requestApproval?: (
    req: {
      sessionId: string;
      runId?: string;
      toolName: string;
      summary: string;
      reason: string;
    },
    signal?: AbortSignal,
  ) => Promise<{ approved: boolean; message?: string }>;
}

/**
 * 组装 query 的 options。顺序即优先级:框架默认 < spec 字段 < 逃生舱(最后 spread)。
 * 不 import SDK,只产出普通对象。
 */
export function buildSdkOptions(
  spec: AgentSpec,
  ctx: RunContext,
  deps: SdkOptionsDeps,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    // ① 框架默认(安全/隔离约定)
    //
    // 权限模式由智能体按【场景】选,不是安全等级:
    //   default            有人盯着的 web 对话,危险操作弹给人确认
    //   bypassPermissions  接口调用,无人值守 —— 等确认只会挂到超时,所以全放行
    //
    // 【为什么现在敢把它开放出去】以前写死 default,是因为 bypassPermissions
    // 会连 canUseTool 一起绕过,而当时路径围栏就住在 canUseTool 里 ——
    // 选了它等于零管控(实测 agent 能随意写宿主 HOME)。
    // 现在围栏搬到了 PreToolUse hook,而 hook 跑在所有权限关卡【之前】,
    // 连 bypassPermissions 都绕不过(sdk-docs/permissions.md:81)。
    // 于是这个选项只决定"要不要问人",不再决定"有没有围栏"。
    permissionMode: spec.permissionMode ?? "default",
    // 让 SDK 吐出逐 token 的 stream_event,前端才能实现打字机效果。
    // 不开的话 query() 只 yield 完整的 assistant 消息,文字一次性出现。
    includePartialMessages: true,
    cwd: ctx.workspaceDir,
    abortController: deps.abort,

    // ② spec 一等公民字段
    model: spec.model.alias,
    systemPrompt: spec.systemPrompt,
    skills: spec.skills,
    mcpServers: toMcpServers(spec, deps.allowStdioMcp),
    agents: toAgents(spec),
    maxTurns: spec.limits.maxTurns,
    effort: spec.limits.effort,

    // 内联 settings。SDK 会把它与 sandbox 合并成同一个 --settings 参数
    // (已实测:合并后 cleanupPeriodDays 仍在,见 options.test.ts 的并存用例)
    settings: { cleanupPeriodDays: TRANSCRIPT_RETENTION_DAYS },

    /**
     * 不加载宿主上的文件系统设置(用户级 settings.json、项目 CLAUDE.md 等)。
     *
     * 这是个多租户平台:宿主机上任何一份 CLAUDE.md 或 settings.json,都会无差别地
     * 混进【每一个租户】的会话。开发机上更明显 —— 本仓库根目录就有 CLAUDE.md。
     * 平台要的是"智能体的行为完全由它自己的配置决定",不是"取决于服务器上碰巧有什么文件"。
     */
    settingSources: [],

    // ③ 续跑 + 环境
    resume: ctx.resumeSessionId,
    env: {
      ...ctx.env,
      ...aliasEnv(ctx.credentials, deps.slots),

      /**
       * HOME 与 CLAUDE_CONFIG_DIR 是两件事,分开设。
       *
       * HOME:给工具缓存一个可写的家(pip/npm/matplotlib 都要写 ~/.cache)。
       *   容器里运行用户的 HOME 常是不可写的 /nonexistent,不改会 EACCES。
       *
       * CLAUDE_CONFIG_DIR:SDK 存 transcript 与全局配置的地方。
       *   以前靠"改了 HOME,SDK 自己去推 $HOME/.claude"搭便车 —— 能用,但是隐式的:
       *   读历史的一方得自己再推一遍同样的规则,推错了就是静默读不到
       *   (实测:主进程不设它时 getSessionMessages 返回 0 条,不报错)。
       *   显式写出来,写入方与读取方引用同一个值。
       */
      HOME: deps.sharedHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir(deps.sharedHome),

      /**
       * 关掉自动记忆。
       *
       * 文档明说它"在 ~/.claude/projects/<project>/memory/ 加载到系统提示中,
       * 【无论 settingSources 如何】" —— 也就是上面那行关不掉它。
       * 对多租户平台,这是一条会把上一个租户的内容带进下一个会话的隐式通道。
       */
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };

  /**
   * 工具白名单。
   *
   * 【这条链曾经断在半路】ToolDef 定义了、AgentConfig 收了、buildSpec 也原样
   * 传下来了,却没人把它交给 SDK —— 配了工具限制的智能体照样能用全部工具。
   * 一个"配置项存在但不生效"的安全设置,比没有这个配置项更糟:
   * 它让人以为已经限制住了。
   *
   * 【allowedTools 本身不足以当白名单】文档原话:"allowed_tools 不约束
   * bypassPermissions。设置 allowed_tools=["Read"] 与 bypassPermissions 一起
   * 仍然批准每个工具,包括 Bash、Write 和 Edit。" 也就是说界面上那句
   * "填了就只允许这些工具"在该模式下是【假的】。
   * 真正的兜底在下面的 hook 里做正向白名单 —— 那一层不受权限模式影响。
   *
   * 这里仍然传 allowedTools:名单内的工具被预批准,少走几道关卡,是纯优化。
   *
   * 【必须判空】allowedTools 给空数组的语义是"一个工具都不许用",
   * 而"没配"的语义是"不限制"。两者不能混。
   */
  const allowed = spec.tools?.map((t) => t.name).filter(Boolean) ?? [];
  if (allowed.length > 0) options.allowedTools = allowed;
  const allowPatterns = allowed.length > 0 ? allowed : undefined;

  // 有 outputSchema 才启用 SDK 原生结构化输出(约束解码)
  if (spec.outputSchema) {
    options.outputFormat = { type: "json_schema", schema: spec.outputSchema };
  }

  // 执行隔离第一道:内核沙箱管住 Bash(命令文本匹配不可信,必须内核级)
  const { sandbox, disallowedTools } = materializeSandbox({
    enabled: deps.sandboxEnabled,
    workspaceDir: ctx.workspaceDir,
    sharedHome: deps.sharedHome,
  });
  if (sandbox) options.sandbox = sandbox;
  if (disallowedTools.length) options.disallowedTools = disallowedTools;

  // 执行隔离第二道:宿主侧文件工具按路径拦截。
  // 它【不依赖内核沙箱】,故本地开发关掉沙箱时依然生效 —— 正是之前两次
  // "agent 用绝对路径写到宿主 HOME" 的直接补救。
  const guardPolicy = {
    workspaceDir: ctx.workspaceDir,
    allowedDirs: [deps.sharedHome, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
  };
  //
  // 语义是【默认放行 + 路径越界即拒】。
  const decide = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ allow: true } | { allow: false; reason: string }> => {
    // 白名单最先判:名单外的工具连守卫和审批都不必走。
    // 【正向白名单而非反向黑名单】不认识的工具一律拒 —— SDK 将来新增工具时,
    // 黑名单会静默放行(fail-open),白名单则自动拒绝(fail-closed)。
    if (allowPatterns && !allowPatterns.some((p) => matchesTool(p, toolName))) {
      return { allow: false, reason: `工具 ${toolName} 不在该智能体的白名单内` };
    }

    // 顺序要紧:先守卫再审批 —— 结构性越界不该浪费人的注意力去审
    const d = guardToolUse(toolName, input, guardPolicy);
    if (!d.allow) return { allow: false, reason: d.reason ?? "越界操作" };

    if (deps.requestApproval) {
      const need = needsApproval(toolName, input, spec.approvalRules);
      if (need.needed) {
        // 【必须 fail-closed】等待审批期间 Redis 不可达时这个 await 会 reject。
        // 曾经没有 try:promise 被 reject,代码根本走不到下面的 deny 分支,
        // 安全的失败闭合路径被整个跳过 —— 会抛异常的围栏不是围栏。
        // 一个需要人确认的危险操作,不能因为审批通道挂了就变成"没人拦"。
        let verdict: Awaited<ReturnType<NonNullable<typeof deps.requestApproval>>>;
        try {
          verdict = await deps.requestApproval(
            {
              sessionId: ctx.sessionId,
              runId: ctx.runId,
              toolName,
              summary: describeToolCall(toolName, input),
              reason: need.reason ?? "需人工确认",
            },
            // 本轮被取消/超时中止时,挂着的审批要跟着立刻收场
            deps.abort.signal,
          );
        } catch (err) {
          return {
            allow: false,
            reason: `审批通道不可用,按拒绝处理:${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (!verdict.approved) {
          return { allow: false, reason: verdict.message ?? "人工审批未通过" };
        }
      }
    }

    return { allow: true };
  };

  /**
   * 围栏挂在 PreToolUse hook 上,【不是】 canUseTool。
   *
   * 【为什么不能用 canUseTool 当围栏】SDK 自己会发这条告警:
   *   CLAUDE_SDK_CAN_USE_TOOL_SHADOWED —— "canUseTool will not be invoked for: Bash.
   *   Bare allowedTools entries auto-approve the whole tool before the callback is consulted."
   * 也就是说,只要智能体配了工具白名单(上面那段传的正是裸工具名),路径守卫和人工审批
   * 就【双双静默失效】。一个本意是收紧权限的配置,反而把围栏拆了 —— 而且不报错。
   * 官方给的正解是 PreToolUse hook:它在所有权限步骤之前跑,连 bypassPermissions 都拦得住。
   *
   * 【不设 matcher】语义是"匹配该事件的每次出现"。围栏漏掉任何一个工具都等于没有。
   *
   * 【timeout 必须显式设】默认只有 60 秒,而人工审批要等真人,上限是 10 分钟。
   * 不放宽的话,等人的审批会先被 hook 超时打断,表现成"还没点就失败了"。
   */
  options.hooks = {
    PreToolUse: [
      {
        timeout: APPROVAL_HOOK_TIMEOUT_SEC,
        hooks: [
          async (hookInput: unknown) => {
            const h = (hookInput ?? {}) as {
              hook_event_name?: string;
              tool_name?: string;
              tool_input?: unknown;
            };
            const toolName = h.tool_name ?? "";
            const input = (h.tool_input ?? {}) as Record<string, unknown>;
            const d = await decide(toolName, input);
            if (d.allow) return {}; // 空对象 = 不表态,继续后续权限评估
            return {
              hookSpecificOutput: {
                hookEventName: h.hook_event_name ?? "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: d.reason,
              },
            };
          },
        ],
      },
    ],
  };

  /**
   * canUseTool 保留,但【只做默认放行,不再重复决策】。
   *
   * 服务端没有人能交互式确认,不给这个回调的话,走到"询问用户"那一步会挂住。
   * 但决策必须只做一次:如果这里再跑一遍审批逻辑,同一次工具调用会弹出两条待审 ——
   * 用户点完一条,还要再点一条一模一样的。
   */
  options.canUseTool = async (_toolName: string, input: Record<string, unknown>) => ({
    behavior: "allow" as const,
    updatedInput: input,
  });

  // ④ 逃生舱:最后 spread,覆盖以上普通默认。
  // stdio MCP 是宿主 RCE 边界,必须在 spread 后再验一次,不能被逃生舱绕过。
  const merged = { ...options, ...spec.escapeHatch };
  assertStdioMcpAllowed(merged.mcpServers, deps.allowStdioMcp);
  return merged;
}
