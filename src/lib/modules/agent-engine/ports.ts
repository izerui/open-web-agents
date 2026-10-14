import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";

/** 一轮在 transcript 里的范围:首尾两条消息的 uuid(含两端)。 */
export interface TranscriptRange {
  first: string;
  last: string;
}

export interface RunResult {
  status: "success" | "failed";
  /** 仅当智能体定义了 outputSchema 且 SDK 产出结构化输出时存在。 */
  structured?: unknown;
  summary?: string;
  /** SDK session id,供下一轮 resume。 */
  sessionId?: string;
  /**
   * 本轮自己产生的第一条与最后一条主线消息(非子代理)的 uuid。
   * 同一 SDK 会话的各轮写进同一份 transcript,回放时按它截出本轮那一段。
   */
  transcriptRange?: TranscriptRange;
  /**
   * partial:运行被中止或异常终止、没等到 SDK 的结算消息,token 数是按已收到的消息累计的,
   * 美元金额未知(usd 为空)。曾经这种情况 cost 直接缺失,取消/超时的运行花费一律不入账。
   */
  cost?: { usd?: number; input: number; output: number; partial?: boolean };
  /** status:上游模型 API 的 HTTP 状态码(仅 api_error 有)。 */
  error?: { kind: string; message: string; status?: number };
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
    /**
     * 只读这一段(按行的 uuid,含两端)。同一 SDK 会话续接的各轮共用一份文件,
     * 不给范围就是整份 —— 只用于没记下范围的旧数据。
     */
    range?: TranscriptRange;
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
