// 域内共享类型。零外部依赖 —— SDK / 框架 / ORM 类型绝不出现在这里。
// 依赖铁律:本文件与 domain/** 禁止 import 任何 next / drizzle / ioredis / claude-agent-sdk。

// ─────────────────────────── 模型与凭证 ───────────────────────────

/** 模型别名槽:平台只暴露角色化的别名,真实 modelId 由网关映射。 */
export type ModelAlias = "fable" | "opus" | "sonnet" | "haiku";

export interface ModelSelection {
  alias: ModelAlias;
}

/** 三级凭证链,优先级 request > session > user > 平台默认。 */
export interface CredentialChain {
  platform?: { baseUrl?: string; key?: string };
  user?: { baseUrl?: string; key?: string };
  session?: { baseUrl?: string; key?: string; model?: ModelAlias };
  request?: { baseUrl?: string; key?: string; model?: ModelAlias };
}

export interface ResolvedCredentials {
  baseUrl: string;
  key: string;
}

// ─────────────────────────── 智能体能力片段 ───────────────────────────

export interface McpDef {
  name: string;
  type: "http" | "stdio";
  url?: string;
  /** stdio MCP 在宿主机启动的程序。仅平台显式开启时允许。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolDef {
  name: string;
}

/** 子代理定义。background 恒为 false:平台强制子代理同步执行,保证过程可监控。 */
export interface SubagentDef {
  name: string;
  /**
   * 【何时】该用这个子代理 —— 不是它是谁。
   *
   * 主 agent 就是靠这句话决定要不要把子任务交出去的,写得含糊等于配了不用。
   * SDK 侧是必需字段;这里留可选是为了兼容此前存下的、没有该字段的配置,
   * 转换时用名字兜底(见 options.ts 的 toAgents)。
   */
  description?: string;
  prompt: string;
  background: false;
}

export type JsonSchema = Record<string, unknown>;

/** 机械验收规则,防 agent 伪造成功(如产物文件必须存在)。 */
export interface VerifyRule {
  kind: string;
  args?: Record<string, unknown>;
}

export type Effort = "low" | "medium" | "high";

/**
 * 权限模式 —— 按使用场景选,不是安全等级排序。
 *
 * 最常用的两个是光谱的两端:
 * - `default`:有人盯着的 web 对话。配合审批规则,危险操作弹给人确认。
 * - `bypassPermissions`:接口调用。无人值守,等确认只会挂到超时,所以全放行。
 *
 * 【重要】无论选哪个模式,路径围栏与审批都仍然生效 —— 它们挂在 PreToolUse hook 上,
 * 而 hook 跑在所有权限关卡【之前】,连 bypassPermissions 都绕不过去
 * (见 sdk-docs/permissions.md:81)。所以这里选的是"要不要问人",
 * 不是"要不要有围栏"。
 */
/**
 * 顺序对齐 Claude 官方客户端的模式菜单(Ask / Accept edits / Plan / Auto / Bypass),
 * 这样用过官方客户端的人不用重新认一遍。
 * `dontAsk` 排在最后 —— SDK 支持,但官方客户端没暴露它。
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
] as const;

/** 类型从常量派生 —— 两处各写一遍必然有一天对不上。 */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 运行契约:域内的 agent 规格,不含任何 SDK 类型。 */
export interface AgentSpec {
  systemPrompt: string;
  skills?: string[];
  mcpServers?: McpDef[];
  tools?: ToolDef[];
  subagents?: SubagentDef[];
  model: ModelSelection;
  /** 有则启用结构化输出 —— 决定该智能体能否被企业系统当接口消费。 */
  outputSchema?: JsonSchema;
  verifyRules?: VerifyRule[];
  /** 人工审批规则(HITL);不配则不审批。 */
  approvalRules?: { tools?: string[]; commandPatterns?: string[]; all?: boolean };
  /** 权限模式;不配等同 "default"。 */
  permissionMode?: PermissionMode;
  limits: { maxTurns?: number; effort?: Effort };
  /** 逃生舱:透传给 SDK 的原始覆盖,最后 spread。 */
  escapeHatch?: Record<string, unknown>;
}

/** 一次运行的上下文。 */
export interface RunContext {
  /** 所属会话。审批、事件归属都要用它定位。 */
  sessionId: string;
  /** 队列里的 run id(worker 执行时有;内联执行可空)。 */
  runId?: string;
  /** 每会话独立的绝对路径工作目录(= 项目 = 工作空间)。 */
  workspaceDir: string;
  /** 本轮用户输入。人用对话与系统 invoke 共用同一字段。 */
  prompt: string;
  /** 上一轮的 SDK session id,用于多轮 resume。 */
  resumeSessionId?: string;
  credentials: ResolvedCredentials;
  env: Record<string, string>;
}

// ─────────────────────────── 归一事件 ───────────────────────────

/**
 * 归一后的域事件。SSE 传输与 jsonl 回放共用同一套。
 * 这是 SDK 消息经 ACL 翻译后的唯一对外形状 —— SDK 升级不外溢到业务层。
 */
export type AgentEvent =
  | { kind: "text"; text: string; subagent?: string }
  | { kind: "thinking"; text: string; subagent?: string }
  | { kind: "tool_use"; tool: string; input: unknown; toolUseId?: string; subagent?: string }
  | { kind: "tool_result"; toolUseId?: string; text: string; isError?: boolean; subagent?: string }
  /**
   * agent 向用户提问(SDK 的 AskUserQuestion)。
   *
   * 【为什么要单独一类事件】SDK 把它实现成一个普通工具,于是它在事件流里跟
   * Read/Bash 长得一样 —— 界面上就是一坨 JSON,用户根本不知道那是在问自己。
   * 而这恰恰是"网页对话"这条入口最该做好的交互:agent 已经把选项都列好了,
   * 白白退化成让用户自己打字。
   *
   * 【为什么不在同一轮里作答】SDK 的 canUseTool 与 PreToolUse hook 都只能
   * 放行/拒绝/改入参,【给不了工具结果】—— 无法替用户把答案塞回去。
   * 所以走多轮:这一轮 SDK 记「用户未作答」,界面把选项渲染成按钮,
   * 用户点了就作为下一轮消息发出去。agent 侧看到的就是一次正常的多轮对话。
   */
  | {
      kind: "question";
      toolUseId?: string;
      questions: {
        question: string;
        header?: string;
        multiSelect?: boolean;
        options: { label: string; description?: string }[];
      }[];
    }
  | { kind: "status"; label: string; state?: string }
  | { kind: "artifact"; path: string; mime: string; url?: string }
  | { kind: "usage"; messageId?: string; input: number; output: number }
  /**
   * 终态事件。
   *
   * `unknown` 是【结局未知】,不是第三种结局:它只用于"这条流到此为止,但运行的
   * 真实结局要另行查询"的场景(如事件通道不可用时的降级收流)。
   * 必须与 success 区分开 —— 否则客户端会把"我不知道"渲染成绿色对勾:
   * 曾经的降级路径就是发 status:"success",事件形状与真正跑完的运行完全一致,
   * 于是 UI 记为成功、卸掉审批轮询,而运行可能随后失败。
   */
  | {
      kind: "result";
      status: "success" | "failed" | "unknown";
      structured?: unknown;
      summary?: string;
      /**
       * 这条终态属于哪一次运行。
       *
       * 【没有它就会串台】事件按会话广播,而两个 SSE 路由都是"收到任意 result 就收流"。
       * 同一会话并发两轮时(API 侧很容易触发,队列也不按 session 串行化),
       * 先跑完的那轮的 result 会把另一轮的流提前关掉 —— 用户看到回答停在半截,
       * 且再也收不到真正属于它的结果。有了 runId,各条流只认自己的终态。
       */
      runId?: string;
    };

/** state 类事件在断线重连时需重放;noise 类可滚动淘汰。 */
// question 归入 state 类:它是【等用户操作】的事件,断线重连后必须还在,
// 否则刷新一下那几个选项就没了,用户只能干等一个永远不会再出现的提问。
export const STATE_EVENT_KINDS = ["status", "artifact", "usage", "result", "question"] as const;

export function isStateEvent(e: AgentEvent): boolean {
  return (STATE_EVENT_KINDS as readonly string[]).includes(e.kind);
}

// ─────────────────────────── Run 状态 ───────────────────────────

export type RunState = "pending" | "running" | "success" | "failed" | "cancelled";
export type RunSignal = "claim" | "finishOk" | "finishErr" | "cancel";
