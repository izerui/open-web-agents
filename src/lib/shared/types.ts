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

// ─────────────────────────── 助手能力片段 ───────────────────────────

export interface McpDef {
  name: string;
  type: "http" | "stdio";
  url?: string;
}

export interface ToolDef {
  name: string;
}

/** 子代理定义。background 恒为 false:平台强制子代理同步执行,保证过程可监控。 */
export interface SubagentDef {
  name: string;
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

/** 运行契约:域内的 agent 规格,不含任何 SDK 类型。 */
export interface AgentSpec {
  systemPrompt: string;
  skills?: string[];
  mcpServers?: McpDef[];
  tools?: ToolDef[];
  subagents?: SubagentDef[];
  model: ModelSelection;
  /** 有则启用结构化输出 —— 决定该助手能否被企业系统当接口消费。 */
  outputSchema?: JsonSchema;
  verifyRules?: VerifyRule[];
  /** 人工审批规则(HITL);不配则不审批。 */
  approvalRules?: { tools?: string[]; commandPatterns?: string[]; all?: boolean };
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
    };

/** state 类事件在断线重连时需重放;noise 类可滚动淘汰。 */
export const STATE_EVENT_KINDS = ["status", "artifact", "usage", "result"] as const;

export function isStateEvent(e: AgentEvent): boolean {
  return (STATE_EVENT_KINDS as readonly string[]).includes(e.kind);
}

// ─────────────────────────── Run 状态 ───────────────────────────

export type RunState = "pending" | "running" | "success" | "failed" | "cancelled";
export type RunSignal = "claim" | "finishOk" | "finishErr" | "cancel";
