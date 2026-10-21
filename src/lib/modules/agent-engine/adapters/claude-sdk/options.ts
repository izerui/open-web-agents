// SDK 选项组装:域内 AgentSpec + RunContext → claude-agent-sdk query 的 options。
// 属 adapter 层,但刻意写成【不 import SDK】的纯函数,便于单测。

import fs from "node:fs/promises";
import path from "node:path";
import { describeToolCall, needsApproval } from "@/lib/modules/agent-engine/domain/approval-rules";
import { parseQuestions } from "@/lib/modules/agent-engine/domain/normalize";
import { materializeSandbox } from "@/lib/modules/agent-engine/domain/sandbox";
import { guardToolUse } from "@/lib/modules/agent-engine/domain/tool-guard";
import { DRAFT_FILE } from "@/lib/modules/agent/domain/design";
import type {
  AgentSpec,
  AskedQuestion,
  ModelAlias,
  ResolvedCredentials,
  RunContext,
} from "@/lib/shared";
import { ESCAPE_HATCH_PROTECTED } from "@/lib/shared/escape-hatch";

/**
 * agent 子进程的 ANTHROPIC_* 环境。
 *
 * 主模型与子代理直接传真实 modelId(scripts/sdk-probe/raw-model-id.mjs 实测可行);
 * 别名槽只服务 SDK 内部按别名发起的辅助调用,全部指向本次运行所属提供者的模型。
 * ANTHROPIC_AUTH_TOKEN 置空:防宿主环境残留的 token 抢占 API_KEY。
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:Bash / hook / stdio MCP 子进程读不到 Key
 * (同一探针实测:不开时 printenv 与 Python 都能读到;开了读到空值,命令与模型调用照常)。
 */
export function aliasEnv(
  creds: ResolvedCredentials,
  slots: Record<ModelAlias, string>,
): Record<string, string> {
  return {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    ANTHROPIC_BASE_URL: creds.baseUrl,
    ANTHROPIC_API_KEY: creds.key,
    ANTHROPIC_AUTH_TOKEN: "",
    // 四个别名槽都要给。漏了哪个,选它的智能体就会用 SDK 内置的默认模型
    // (scripts/sdk-probe/model-alias.mjs 实测:fable 未固定时发给网关的是 claude-opus-5-5)
    ANTHROPIC_DEFAULT_FABLE_MODEL: slots.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: slots.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: slots.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: slots.haiku,
    ANTHROPIC_SMALL_FAST_MODEL: slots.haiku,
  };
}

function slotsOf(modelId: string): Record<ModelAlias, string> {
  return { fable: modelId, opus: modelId, sonnet: modelId, haiku: modelId };
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
      // 运行时已解析成同一提供者下的真实模型标识;没配的子代理跟主模型一样
      ...(spec.subagentModels?.[s.name] ? { model: spec.subagentModels[s.name] } : {}),
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
  /**
   * 宿主真实 HOME。只用于把 denyReadDirs 里的 `~` 展开到【该护的那个家】——
   * 平台运维的 ~/.ssh、~/.claude 在这里,而不是在 agent 的 sharedHome 下。
   */
  hostHome: string;
  /**
   * 当前平台。不传则用进程的。显式传入便于穷举单测。
   */
  platform?: NodeJS.Platform;
  abort: AbortController;
  /**
   * 是否启用 OS 内核沙箱。
   *
   * 【macOS 本地必须关】实测:seatbelt 沙箱下 Bash 工具【命令根本不执行】——
   * 不只是吞 stdout:文件没写成、重定向也产不出日志,但 SDK 报告成功,
   * 于是模型以为已经做完。这比没输出严重得多。
   * 生产 Linux 走 bubblewrap,不受该缺陷影响 —— 默认开依然正确。
   */
  sandboxEnabled: boolean;
  /** 是否允许在宿主机启动 stdio MCP 进程。 */
  allowStdioMcp: boolean;
  /** 已写好的技能插件目录(由 runner 生成)。 */
  skillPluginPath?: string;
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
      /** 这次调用所属的全部类别 —— 本会话若每一类都已授权,就不必再问人 */
      scopes?: { key: string; label: string }[];
    },
    signal?: AbortSignal,
  ) => Promise<{ approved: boolean; message?: string }>;
  /**
   * 智能体提问(AskUserQuestion)时在同一轮里等人回答。给了且这次运行有人在(审批策略为 ask)才启用;
   * 返回答案(键为问题原文)、不回答的说明,或都没有(超时 / 停止 / 通道不可用)。
   * 实现方负责有界等待;signal 必须透传,运行被停止时待回答要立刻收场
   */
  askUser?: (
    req: {
      sessionId: string;
      runId?: string;
      toolUseId?: string;
      questions: AskedQuestion[];
    },
    signal?: AbortSignal,
  ) => Promise<{ answers?: Record<string, string>; declined?: string }>;
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
    // 【为什么无人值守要换默认值】invoke 是一次调用拿结果。没人能确认时还走
    // “问人”的模式,只会把本可以成功的任务挂成超时失败。智能体显式配了就听它的。
    //
    // 【为什么现在敢把它开放出去】以前写死 default,是因为 bypassPermissions
    // 会连 canUseTool 一起绕过,而当时路径围栏就住在 canUseTool 里 ——
    // 选了它等于零管控(实测 agent 能随意写宿主 HOME)。
    // 现在围栏搬到了 PreToolUse hook,而 hook 跑在所有权限关卡【之前】,
    // 连 bypassPermissions 都绕不过(sdk-docs/permissions.md:81)。
    // 于是这个选项只决定"要不要问人",不再决定"有没有围栏"。
    permissionMode: spec.permissionMode ?? (ctx.unattended ? "bypassPermissions" : "default"),
    // 让 SDK 吐出逐 token 的 stream_event,前端才能实现打字机效果。
    // 不开的话 query() 只 yield 完整的 assistant 消息,文字一次性出现。
    includePartialMessages: true,
    cwd: ctx.workspaceDir,
    abortController: deps.abort,

    // ② spec 一等公民字段
    model: spec.model.modelId,
    systemPrompt: spec.systemPrompt,
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
    // 从某条消息之后接着跑时必须分到新会话:不分的话新的一轮会写进原文件,原对话就被改写了
    // (scripts/sdk-probe/branch-resume-at.mjs 实测:模型只看到那条消息之前的对话)
    ...(ctx.resumeSessionId && ctx.resumeSessionAt
      ? { resumeSessionAt: ctx.resumeSessionAt, forkSession: true }
      : {}),
    env: {
      ...ctx.env,
      ...aliasEnv(ctx.credentials, ctx.modelSlots ?? slotsOf(spec.model.modelId)),

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
       * PWD / INIT_CWD 必须跟着 cwd 走。
       *
       * 【不盖的后果】ctx.env 继承自平台进程,里面的 PWD 是服务进程的工作目录 ——
       * 本地开发时那就是仓库根。模型会把它当成「当前工程」,于是主动把任务产物
       * 写进源码目录 —— cwd 已经指对了也拦不住,因为它看的是环境变量。
       */
      PWD: ctx.workspaceDir,
      INIT_CWD: ctx.workspaceDir,

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
    hostHome: deps.hostHome,
  });
  if (sandbox) options.sandbox = sandbox;

  /**
   * 【不按“有没有人”增删 agent 的工具面】曾经在无人值守时把 AskUserQuestion
   * 追加进拒绝列表,理由是“没人能答,留着白跑一轮”。但调用它的动作本身包含
   * 一次结构化推理(枚举 2-4 个候选方案并权衡),摘掉它可能让 agent 在歧义任务上
   * 直接选一条路走 —— 这是对输出质量的干预,而平台没有数据支撑这个取舍。
   *
   * 工具面是 agent 自己的事:要锁定就配 `tools` 白名单(SDK 官方对“锁定代理”的建议),
   * 平台只负责把“没人可问”这个运行时事实通过 permissionMode 传给 SDK。
   */
  if (disallowedTools.length) options.disallowedTools = disallowedTools;

  // 智能体自带的技能:平台写好的只读插件目录(见 skill-plugin.ts)
  if (deps.skillPluginPath) {
    options.plugins = [{ type: "local", path: deps.skillPluginPath }];
  }

  // 执行隔离第二道:宿主侧文件工具按路径拦截。
  // 它【不依赖内核沙箱】,故本地开发关掉沙箱时依然生效 —— 正是之前两次
  // "agent 用绝对路径写到宿主 HOME" 的直接补救。
  //
  // 【写只允许工作目录 + 临时目录】allowedDirs 曾经把 sharedHome 也放开了,
  // 于是 Write/Edit 能直接写 agent 的 HOME(.agent-home 里有 .claude 配置与
  // 全部会话 transcript)。但工具缓存(pip/npm/matplotlib)是 Bash 子进程写的,
  // 走的是内核沙箱的 allowWrite,压根不经过这道守卫 —— 也就是说放开 sharedHome
  // 对合法场景没有任何帮助,只是白白多了一条写入路径。
  // 临时目录保留:它是通用约定,且沙箱的 allowWrite 同样包含,两边语义一致。
  const guardPolicy = {
    workspaceDir: ctx.workspaceDir,
    allowedDirs: ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
  };
  //
  // 语义是【默认放行 + 路径越界即拒】。
  const decide = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ allow: true } | { allow: false; reason: string }> => {
    if (ctx.designMode && toolName !== "AskUserQuestion") {
      if (
        !["Read", "Write", "Edit"].includes(toolName) ||
        typeof input.file_path !== "string" ||
        path.resolve(ctx.workspaceDir, input.file_path) !==
          path.resolve(ctx.workspaceDir, DRAFT_FILE)
      ) {
        return {
          allow: false,
          reason: "AI 编辑仅可读取和修改设计草稿,不能创建技能脚本或访问其它文件",
        };
      }
      const stat = await fs.lstat(path.join(ctx.workspaceDir, DRAFT_FILE)).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        return { allow: false, reason: "设计草稿不是普通文件" };
      }
    }
    // 白名单最先判:名单外的工具连守卫和审批都不必走。
    // 【正向白名单而非反向黑名单】不认识的工具一律拒 —— SDK 将来新增工具时,
    // 黑名单会静默放行(fail-open),白名单则自动拒绝(fail-closed)。
    if (allowPatterns && !allowPatterns.some((p) => matchesTool(p, toolName))) {
      return { allow: false, reason: `工具 ${toolName} 不在该智能体的白名单内` };
    }

    // 顺序要紧:先守卫再审批 —— 结构性越界不该浪费人的注意力去审
    const d = guardToolUse(toolName, input, guardPolicy);
    if (!d.allow) return { allow: false, reason: d.reason ?? "越界操作" };

    // 【没有审批人时不等人】接口调用、评测里没有人能点批准。
    // 照常发审批的后果是白等满 10 分钟、超时自动拒绝。按智能体配置直接放行或拒绝;
    // 路径围栏与工具白名单仍然生效 —— 那两道是结构性安全边界,不依赖人。
    const policy = ctx.approvalPolicy ?? (ctx.unattended ? "allow" : "ask");
    const need = deps.requestApproval
      ? needsApproval(toolName, input, spec.approvalRules)
      : { needed: false };
    if (need.needed && policy === "deny") {
      return {
        allow: false,
        reason: `该操作需要人工审批,而当前入口没有审批人,按智能体配置拒绝(${need.reason ?? toolName})`,
      };
    }
    if (deps.requestApproval && need.needed && policy === "ask") {
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
            ...(need.scopes ? { scopes: need.scopes } : {}),
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
  /**
   * 提问在同一轮里等人回答(见 approval/application/ask-user.ts)。
   *
   * 【为什么在 hook 里做】SDK 的同轮作答靠"放行时改写入参、带上 answers"。canUseTool 在配了
   * 工具白名单时会被跳过(见下),而 PreToolUse hook 一定会跑,且同样能返回改写后的入参 ——
   * 两条路模型收到的都是"The user answered: …"(scripts/sdk-probe/ask-user-question.mjs 实测)。
   * 没人可问(接口调用、API Key 会话、评测)、入参形状不认识、没等到回答:不表态,SDK 照旧告诉模型"用户没有回答"。
   */
  // 显式白名单:只有入口声明了有人对着提问卡片才等(见 RunContext.canAskUser)
  const humanPresent = ctx.canAskUser === true && !ctx.unattended;
  const askInTurn = async (
    hookEventName: string,
    toolUseId: string | undefined,
    input: Record<string, unknown>,
  ) => {
    const questions = deps.askUser && humanPresent ? parseQuestions(input) : null;
    if (!deps.askUser || !questions) return {};
    // 答案的键必须是模型给的问题原文(界面看到的可能被截断过)
    const raw = (input.questions as { question: string }[]).map((q) => q.question);
    const asked = questions.map((q, i) => ({ ...q, question: raw[i] ?? q.question }));
    const got = await deps.askUser(
      { sessionId: ctx.sessionId, runId: ctx.runId, toolUseId, questions: asked },
      deps.abort.signal,
    );
    if (got.answers) {
      return {
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "allow",
          updatedInput: { ...input, answers: got.answers },
        },
      };
    }
    if (got.declined !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: `用户选择不回答这些问题${got.declined ? `:${got.declined}` : ""}。请按你的判断继续,或换个方式说明`,
        },
      };
    }
    return {};
  };

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
              tool_use_id?: string;
            };
            const toolName = h.tool_name ?? "";
            const input = (h.tool_input ?? {}) as Record<string, unknown>;
            const d = await decide(toolName, input);
            if (d.allow && toolName === "AskUserQuestion") {
              return askInTurn(h.hook_event_name ?? "PreToolUse", h.tool_use_id, input);
            }
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

  // ④ 逃生舱:最后 spread,覆盖以上普通默认 —— 但【安全边界字段一律以平台为准】。
  //
  // 曾经是无条件覆盖,任何能建智能体的用户都能用一份 escapeHatch 关掉沙箱、清空 hooks
  // (路径围栏、工具白名单、审批都挂在 PreToolUse 上)、把 cwd 改成 /、换掉 settingSources。
  // 逃生舱留给"平台没建模的普通参数",不是安全开关。
  const merged: Record<string, unknown> = { ...options, ...spec.escapeHatch };
  for (const k of ESCAPE_HATCH_PROTECTED) {
    if (k in options) merged[k] = options[k];
    else delete merged[k];
  }
  assertStdioMcpAllowed(merged.mcpServers, deps.allowStdioMcp);
  return merged;
}
