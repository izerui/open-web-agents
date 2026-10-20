// 把 SDK 的 result 消息提取为域内 RunResult。纯逻辑,入参 unknown。

import type { RunResult } from "@/lib/modules/agent-engine/ports";
import { extractJsonObject } from "./extract-json";
import {
  type ModelMetering,
  type TokenBreakdown,
  extractModelUsage,
  missingOf,
  readTokenCount,
  unattributedOf,
} from "./model-usage";

/**
 * 计量:有 modelUsage 按模型给出;没有按模型的明细时,把 result.usage 里明确给出的四项
 * (输入、输出、缓存读、缓存写)记为未归属用量,结算按主模型价计 —— 收到 result 后之前按消息
 * 累计的用量会清空,这里不留下缓存两项,观察到的缓存用量就整段丢了。
 */
const count = (v: unknown) => {
  const c = readTokenCount(v);
  return c === "missing" ? 0 : c;
};

/**
 * result.usage 的四项:读得出的(含有效的零、没给的缓存项)照常计;明确给出却读不出的
 * (负数、字符串等)不能当零 —— 记为计量缺失,结算据此保持暂记。usage 本身不是对象也算缺失。
 */
function readResultUsage(usage: unknown): { tokens: TokenBreakdown; missing: number } {
  const tokens: TokenBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  if (usage === undefined || usage === null) return { tokens, missing: 0 };
  if (typeof usage !== "object" || Array.isArray(usage)) return { tokens, missing: 1 };
  const raw = usage as Record<string, unknown>;
  let missing = 0;
  for (const [key, field] of [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["cacheReadTokens", "cache_read_input_tokens"],
    ["cacheWriteTokens", "cache_creation_input_tokens"],
  ] as const) {
    const c = readTokenCount(raw[field]);
    if (c === "missing") missing += 1;
    else tokens[key] = c;
  }
  return { tokens, missing };
}

/**
 * 这条 result 的计量里有没有可用的非零计数(按模型的明细或未归属用量)。
 * 没有 usage、usage 全是 0、modelUsage 为空对象或全是 0、只有读不出的计数都不算 ——
 * error result 常带这样的计量,它们证明不了"没有用量",调用方不能拿来覆盖之前按消息观察到的非零用量。
 */
export function hasMeteringBasis(metering: ModelMetering | undefined): boolean {
  if (!metering) return false;
  const nonZero = (u: TokenBreakdown) =>
    u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0 || u.cacheWriteTokens > 0;
  return metering.models.some(nonZero) || unattributedOf(metering) !== null;
}

function meteringOf(m: Record<string, unknown>): { metering?: ModelMetering } {
  const { tokens, missing } = readResultUsage(m.usage);
  const any =
    tokens.inputTokens || tokens.outputTokens || tokens.cacheReadTokens || tokens.cacheWriteTokens;
  // 只算 result 自己这一条的用量(多条 result 合并时逐条相加)
  const fromUsage = (base: ModelMetering): ModelMetering => {
    const total = missingOf(base) + missing;
    return {
      ...base,
      complete: false,
      ...(any ? { unattributed: tokens } : {}),
      ...(total > 0 ? { missing: total } : {}),
      fromResultUsage: true,
    };
  };
  if (m.modelUsage !== undefined) {
    const metering = extractModelUsage(m.modelUsage);
    // modelUsage 里没有可用的非零计数(空的、全是 0、各项都读不出):退回用 result.usage 的四项,
    // modelUsage 记下的计量缺失一并保留;有可用非零计数时以 modelUsage 为准,不叠加 usage
    if (!hasMeteringBasis(metering) && (any || missing > 0)) {
      return { metering: fromUsage(metering) };
    }
    return { metering };
  }
  return any || missing > 0
    ? { metering: fromUsage({ source: "sdk_model_usage", complete: false, models: [] }) }
    : {};
}

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
    // 总数只取读得出的;读不出的已在计量里记为缺失
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    ...meteringOf(m),
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
