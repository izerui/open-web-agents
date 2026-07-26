// EnginePort 的 claude-agent-sdk 实现。
//
// 可测性设计:类本身依赖【注入的 queryFn】,不 import SDK —— 单测喂录制的消息序列即可回放,
// 不碰网络、不装模型。真实 SDK 的绑定在 default-engine.ts 的工厂里(唯一 import SDK 的地方)。

import { extractRunResult } from "@/lib/modules/agent-engine/domain/extract-result";
import {
  createSubagentLabeler,
  normalizeSdkMessage,
} from "@/lib/modules/agent-engine/domain/normalize";
import type { EnginePort, RunResult } from "@/lib/modules/agent-engine/ports";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { buildSdkOptions } from "./options";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface EngineDeps {
  /** agent 子进程共享 HOME(工具缓存跨会话复用)。 */
  sharedHome: string;
  /** 别名 → 真实 modelId 的映射来源。 */
  gateway: ModelGatewayPort;
  /** 是否启用 OS 内核沙箱(macOS 本地开发常关:seatbelt 会吞 stdout)。 */
  sandboxEnabled: boolean;
  /** 人工审批钩子(HITL);不给则不启用审批。 */
  requestApproval?: (req: {
    sessionId: string;
    runId?: string;
    toolName: string;
    summary: string;
    reason: string;
  }) => Promise<{ approved: boolean; message?: string }>;
}

export class ClaudeSdkEngine implements EnginePort {
  constructor(
    private readonly queryFn: QueryFn,
    private readonly deps: EngineDeps,
  ) {}

  async run(
    spec: AgentSpec,
    ctx: RunContext,
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const abort = new AbortController();
    if (signal.aborted) abort.abort();
    const onOuterAbort = () => abort.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    // 子代理归属标签有状态、跨消息记忆映射,故在消息循环外实例化
    const label = createSubagentLabeler();
    const hasSchema = spec.outputSchema !== undefined;

    let sessionId: string | undefined;
    let result: RunResult | undefined;

    try {
      const stream = this.queryFn({
        prompt: ctx.prompt,
        options: buildSdkOptions(spec, ctx, {
          sharedHome: this.deps.sharedHome,
          abort,
          slots: this.deps.gateway.slots(),
          sandboxEnabled: this.deps.sandboxEnabled,
          requestApproval: this.deps.requestApproval,
        }),
      });

      for await (const msg of stream) {
        const m = msg as { type?: string; subtype?: string; session_id?: string } | null;

        if (m?.type === "system" && m.subtype === "init") {
          sessionId = m.session_id ?? sessionId;
        } else if (m?.type === "result") {
          result = extractRunResult(msg, { hasSchema });
        } else {
          for (const e of normalizeSdkMessage(msg)) onEvent(label(e));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        sessionId,
        error: { kind: abort.signal.aborted ? "aborted" : "engine_error", message },
      };
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
    }

    // 流结束却没收到 result 消息:被中断或 SDK 异常终止
    if (!result) {
      return {
        status: "failed",
        sessionId,
        error: abort.signal.aborted
          ? { kind: "aborted", message: "运行被中断" }
          : { kind: "no_result", message: "SDK 未产出 result 消息" },
      };
    }

    return { ...result, sessionId };
  }
}
