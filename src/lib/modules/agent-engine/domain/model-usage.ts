export interface ModelTokenUsage {
  modelId: string;
  /** SDK 的原始标签可能包含上下文窗口后缀;价格匹配使用 SDK 提供的 canonicalModel。 */
  reportedModelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** complete=false 或字段缺失不能作为自动积分结算的完整用量。 */
export interface ModelMetering {
  source: "sdk_model_usage";
  complete: boolean;
  /** 含按消息累计、没等到 SDK 结算消息的用量(取消、失败、多轮中断) */
  partial?: boolean;
  models: ModelTokenUsage[];
}

/** SDK result.modelUsage 按真实模型给出本次 query 累计计量,包括子代理。 */
export function extractModelUsage(raw: unknown): ModelMetering {
  const out: ModelMetering = { source: "sdk_model_usage", complete: true, models: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...out, complete: false };
  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ] as const;
  for (const [modelId, value] of Object.entries(raw)) {
    if (
      !modelId ||
      modelId.length > 200 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      out.complete = false;
      continue;
    }
    const v = value as Record<string, unknown>;
    if (
      fields.some(
        (field) =>
          typeof v[field] !== "number" ||
          !Number.isSafeInteger(v[field]) ||
          (v[field] as number) < 0,
      )
    ) {
      out.complete = false;
      continue;
    }
    const canonical =
      typeof v.canonicalModel === "string" &&
      v.canonicalModel.length > 0 &&
      v.canonicalModel.length <= 200
        ? v.canonicalModel
        : modelId;
    out.models.push({
      modelId: canonical,
      ...(canonical !== modelId ? { reportedModelId: modelId } : {}),
      inputTokens: v.inputTokens as number,
      outputTokens: v.outputTokens as number,
      cacheReadTokens: v.cacheReadInputTokens as number,
      cacheWriteTokens: v.cacheCreationInputTokens as number,
    });
  }
  // 没有模型明细不能证明本次没有消耗,留给结算层核对。
  if (out.models.length === 0) out.complete = false;
  return out;
}
