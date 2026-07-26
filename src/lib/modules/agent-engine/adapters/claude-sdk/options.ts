// SDK 选项组装:域内 AgentSpec + RunContext → claude-agent-sdk query 的 options。
// 属 adapter 层,但刻意写成【不 import SDK】的纯函数,便于单测。

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

/** McpDef[] → SDK mcpServers 形状 `{ [name]: { type, url } }`。 */
function toMcpServers(spec: AgentSpec): Record<string, unknown> | undefined {
  if (!spec.mcpServers?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of spec.mcpServers) out[s.name] = { type: s.type, url: s.url };
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
    // 用 default 而非 bypassPermissions:后者的定义是"Bypass all permission checks",
    // 连 canUseTool 都不会被调用 —— 实测在沙箱关闭时 agent 能随意写到宿主 HOME,
    // 即零管控。default 模式下每个权限决策都路由到下面的 canUseTool,由平台自己判。
    permissionMode: "default",
    cwd: ctx.workspaceDir,
    abortController: deps.abort,

    // ② spec 一等公民字段
    model: spec.model.alias,
    systemPrompt: spec.systemPrompt,
    skills: spec.skills,
    mcpServers: toMcpServers(spec),
    agents: spec.subagents,
    maxTurns: spec.limits.maxTurns,
    effort: spec.limits.effort,

    // ③ 续跑 + 环境
    resume: ctx.resumeSessionId,
    env: {
      ...ctx.env,
      ...aliasEnv(ctx.credentials, deps.slots),
      HOME: deps.sharedHome,
    },
  };

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
  // 语义是【默认放行 + 路径越界即拒】:服务端没有人可以交互式确认,
  // 所以这个回调既是"审批人"也是唯一的围栏。
  options.canUseTool = (toolName: string, input: Record<string, unknown>) => {
    const d = guardToolUse(toolName, input, guardPolicy);
    return d.allow
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: d.reason };
  };

  // ④ 逃生舱:最后 spread,覆盖以上任何默认
  return { ...options, ...spec.escapeHatch };
}
