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

/** 唯一与 claude-agent-sdk 接触的边界。实现只允许出现在 adapters/claude-sdk/**。 */
export interface EnginePort {
  run(
    spec: AgentSpec,
    ctx: RunContext,
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<RunResult>;
}
