import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";

export interface RunResult {
  status: "success" | "failed";
  /** 仅当助手定义了 outputSchema 且 SDK 产出结构化输出时存在。 */
  structured?: unknown;
  summary?: string;
  /** SDK session id,供下一轮 resume。 */
  sessionId?: string;
  cost?: { usd?: number; input: number; output: number };
  error?: { kind: string; message: string };
  /**
   * 结构化结果是从最终文本里提取的(而非 SDK 原生 structured_output)。
   * 兼容网关不支持 output_format 时的降级标记,便于运维识别与排查。
   */
  salvagedFromText?: boolean;
}

/**
 * 读取 SDK 落盘的会话过程记录(transcript)。
 *
 * 【为什么需要它】过程事件此前只活在 Redis 与进程内的 replay 缓冲里,运行一结束就没了 ——
 * 用户刷新页面,刚才看到的思考、工具调用、产出全部消失。而 SDK 自己就把完整过程写成了
 * jsonl,一直在盘上:与其新建一张事件表去重复存一遍(还要维护一致性与保留期),
 * 不如直接读它。
 *
 * 【为什么是端口】读盘是 IO,且落盘格式与位置由 SDK 决定 —— 它是会变的外部依赖。
 * 将来若改用 SDK 的 SessionStore 把 transcript 镜像到 S3(见 sdk-docs/session-storage.md),
 * 换的就是这个端口的实现,用例层不动。
 */
export interface TranscriptPort {
  /**
   * 读出一次 SDK 会话的全部过程事件。
   *
   * 【读不到必须返回空数组而不是抛错】transcript 缺失是常态而非异常:工作空间被清理、
   * 跨机部署读不到别的机器写的文件、运行在引擎启动前就失败。抛错会让整个历史接口 500,
   * 而其余轮次本来是能正常回放的 —— 一轮缺失不该毁掉整份历史。
   */
  read(args: {
    dataDir: string;
    workspaceDir: string;
    sdkSessionId: string;
  }): Promise<AgentEvent[]>;
}

/** 唯一与 claude-agent-sdk 接触的边界。实现只允许出现在 adapters/claude-sdk/**。 */
export interface EnginePort {
  run(
    spec: AgentSpec,
    ctx: RunContext,
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<RunResult>;
}
