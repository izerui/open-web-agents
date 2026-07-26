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
