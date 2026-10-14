// 域内共享类型。零外部依赖 —— SDK / 框架 / ORM 类型绝不出现在这里。
// 依赖铁律:本文件与 domain/** 禁止 import 任何 next / drizzle / ioredis / claude-agent-sdk。

// ─────────────────────────── 模型与凭证 ───────────────────────────

/** 模型别名槽:平台只暴露角色化的别名,真实 modelId 由网关映射。 */
export type ModelAlias = "fable" | "opus" | "sonnet" | "haiku";

export const MODEL_ALIASES: readonly ModelAlias[] = ["fable", "opus", "sonnet", "haiku"];

export function isModelAlias(v: string): v is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(v);
}

export interface ModelSelection {
  alias: ModelAlias;
}

/**
 * 三级凭证链,优先级 request > user > 平台默认。
 * (曾经还有一层"会话级凭证",但从没有任何代码写入它:base_url / model 读出来恒为空,
 * key_enc 连读都没读 —— 半截链路只会让人误以为能按会话换网关,已删除。)
 */
export interface CredentialChain {
  platform?: { baseUrl?: string; key?: string };
  user?: { baseUrl?: string; key?: string };
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
  /**
   * 这个子代理用的模型别名;不填 = 跟主 agent 一样。
   * 只收别名,不收完整模型 id —— 别名经平台的模型映射(OWA_MODEL_*)落到真实模型,
   * 子代理不该绕开它。典型用法:主 agent 用 opus,检索 / 汇总类子代理用 haiku 省钱。
   */
  model?: ModelAlias;
  background: false;
}

export type JsonSchema = Record<string, unknown>;

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
  /** 智能体自带的技能包,运行时作为本地插件加载。 */
  skillPackages?: import("./skill-package").SkillPackage[];
  mcpServers?: McpDef[];
  tools?: ToolDef[];
  subagents?: SubagentDef[];
  model: ModelSelection;
  /** 有则启用结构化输出 —— 决定该智能体能否被企业系统当接口消费。 */
  outputSchema?: JsonSchema;
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
  /**
   * 在 resumeSessionId 那份会话里从这条消息之后接着跑,并分到新会话(SDK 的 resumeSessionAt +
   * forkSession)。用于"从某一轮重来":回到那一轮之前的状态,原对话不受影响。
   */
  resumeSessionAt?: string;
  /**
   * 无人值守。
   *
   * 接口 invoke 是一次调用拿结果,没有人能在中途确认任何东西 ——
   * 此时“等人”只会挂到超时,把本可以成功的任务拖成失败。故需要人确认的
   * 关口一律直接放行;路径围栏与工具白名单不受影响(那是安全边界,不是“要不要问人”)。
   */
  unattended?: boolean;
  /**
   * 命中审批规则时怎么办:ask 等人批 / allow 直接放行 / deny 直接拒绝。
   * 不传时按 unattended 推断(无人值守放行,否则等人)。
   * 嵌入组件里有人但不是审批人(终端访客不该替运营方批准危险操作),只能 allow 或 deny。
   */
  approvalPolicy?: "ask" | "allow" | "deny";
  credentials: ResolvedCredentials;
  env: Record<string, string>;
  /** 运行中途追加消息的收件箱;不给 = 这一轮不接受追加(一次性输入)。 */
  steer?: SteerInbox;
}

/** 一条追加消息。 */
export interface SteerMessage {
  id: string;
  text: string;
}

/**
 * 运行中途追加消息的收件箱(引擎侧看到的样子)。
 *
 * 【送达的定义】引擎从 next() 取到一条、交给模型输入流之前调 delivered() —— 之后它要么插进
 * 当前这一轮,要么在本轮回答后再答一轮。close() 之后不再受理新消息,但已受理的仍会从 next()
 * 取到;abandon() 是运行结束、模型不再读输入:还没取走的一律记为未送达。
 */
export interface SteerInbox {
  /** 下一条;已关闭且取完返回 null。 */
  next(): Promise<SteerMessage | null>;
  delivered(m: SteerMessage): Promise<void>;
  /** 停止受理(第一条 result 到达时调用)。幂等。 */
  close(): Promise<void>;
  /** 运行结束:剩下的记为未送达,并让挂着的 next() 返回 null。幂等。 */
  abandon(): Promise<SteerMessage[]>;
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
   * 【为什么当前走多轮作答】SDK 本身支持同轮作答:它把 AskUserQuestion 送到 canUseTool,
   * 宿主收集答案后经 `updatedInput: { questions, answers }` 回传即可(见 sdk-docs/user-input.md)。
   * 但平台目前把 canUseTool 写成了无条件放行(围栏改挂在 PreToolUse hook 上,而 hook 只能
   * allow/deny、给不了 updatedInput),于是提问被直接放过。界面把选项渲染成按钮,
   * 用户点了就作为下一轮消息发出去 —— agent 侧看到的是一次正常的多轮对话。
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
  /**
   * 运行中途用户追加的消息。delivered = 已交给模型(会插进当前这一轮,或在本轮回答后再答一轮);
   * dropped = 运行已经结束、没能交给模型 —— 界面据此提示用户重新发送。
   */
  | { kind: "steer"; id?: string; text: string; outcome: "delivered" | "dropped" }
  | {
      kind: "usage";
      messageId?: string;
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
    }
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
      status: "success" | "failed" | "cancelled" | "unknown";
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

// ─────────────────────────── Run 状态 ───────────────────────────

export type RunState = "pending" | "running" | "success" | "failed" | "cancelled";
export type RunSignal = "claim" | "finishOk" | "finishErr" | "cancel";
