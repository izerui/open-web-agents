// 把 SDK 的 result 消息提取为域内 RunResult。纯逻辑,入参 unknown。

import type { RunResult } from "@/lib/modules/agent-engine/ports";
import { extractJsonObject } from "./extract-json";

/**
 * 从 SDK `result` 消息提取 RunResult。
 *
 * - status:仅 `subtype==="success"` 算成功
 * - structured:官方约定只在 success 时可读;错误 subtype 下即便带残留输出也不当契约结果
 * - 契约缺失:助手声明了 outputSchema 却没拿到 structured_output → 降为 failed
 *   (否则调用方会拿到一个"成功但没有结果"的响应,对接系统无法消费)
 */
export function extractRunResult(resultMsg: unknown, opts: { hasSchema: boolean }): RunResult {
  const m = (resultMsg && typeof resultMsg === "object" ? resultMsg : {}) as Record<
    string,
    unknown
  >;
  const isSuccess = m.subtype === "success";
  const usage = (m.usage ?? {}) as { input_tokens?: number; output_tokens?: number };

  const cost = {
    usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  const summary = typeof m.result === "string" ? m.result : undefined;

  if (!isSuccess) {
    return {
      status: "failed",
      summary,
      cost,
      error: { kind: String(m.subtype ?? "unknown"), message: summary ?? "run failed" },
    };
  }

  if (opts.hasSchema && m.structured_output === undefined) {
    // 降级路径:第三方兼容网关对 output_format 支持不一致,常常拿不到 structured_output。
    // 此时从最终文本里提取 JSON —— 提取到的结果仍要过 outputSchema 校验,不放松契约。
    const salvaged = summary === undefined ? undefined : extractJsonObject(summary);
    if (salvaged !== undefined) {
      return { status: "success", structured: salvaged, summary, cost, salvagedFromText: true };
    }
    return {
      status: "failed",
      summary,
      cost,
      error: {
        kind: "no_structured_output",
        message: "助手声明了 outputSchema 但未产出结构化结果,且无法从文本中提取",
      },
    };
  }

  return { status: "success", structured: m.structured_output, summary, cost };
}
