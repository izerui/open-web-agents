// 把 SDK 的 result 消息提取为域内 RunResult。纯逻辑,入参 unknown。

import type { RunResult } from "@/lib/modules/agent-engine/ports";
import { extractJsonObject } from "./extract-json";
import { extractModelUsage } from "./model-usage";

/**
 * 从 SDK `result` 消息提取 RunResult。
 *
 * - status:`subtype==="success"` 且 `is_error` 不为 true 才算成功
 *   (上游模型 API 报错时 SDK 仍给 subtype:"success",失败信号只在 is_error / api_error_status 上)
 * - structured:官方约定只在 success 时可读;错误 subtype 下即便带残留输出也不当契约结果
 * - 契约缺失:智能体声明了 outputSchema 却没拿到 structured_output → 降为 failed
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
    ...(m.modelUsage !== undefined ? { metering: extractModelUsage(m.modelUsage) } : {}),
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

  // 【subtype 是 success 不等于成功】上游网关 503、鉴权失败等 API 错误,SDK 照样给
  // subtype:"success",只把 is_error 置 true,result 里是 "API Error: 503 ..." 这样的报错文本。
  // 只看 subtype,这段报错就会被记成一次成功运行的最终回答:界面显示成功、invoke 的
  // 调用方拿到 status:"success"、webhook 也按成功推送。残留的 structured_output 同样不采信。
  if (m.is_error === true) {
    const status = typeof m.api_error_status === "number" ? m.api_error_status : undefined;
    return {
      status: "failed",
      summary,
      cost,
      error: {
        kind: "api_error",
        message: summary ?? "上游模型 API 报错",
        ...(status !== undefined ? { status } : {}),
      },
    };
  }

  // 【== null 而非 === undefined】:第三方兼容网关(DashScope/GLM 等)不支持
  // output_format 时,返回的是显式的 `"structured_output": null` 而不是缺字段。
  // 用严格相等会整个跳过下面这段降级 —— 这个分支存在的全部理由就是应对它们,
  // 结果它对最常见的那种返回形态失效,最后以笼统的 schema_mismatch 报错。
  if (opts.hasSchema && m.structured_output == null) {
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
        message: "智能体声明了 outputSchema 但未产出结构化结果,且无法从文本中提取",
      },
    };
  }

  return { status: "success", structured: m.structured_output, summary, cost };
}
