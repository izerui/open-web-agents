export interface ModelTokenUsage {
  modelId: string;
  /** SDK 的原始标签可能包含上下文窗口后缀;价格匹配使用 SDK 提供的 canonicalModel。 */
  reportedModelId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 一份按输入、输出、缓存读、缓存写分开的 token 用量 */
export type TokenBreakdown = Omit<ModelTokenUsage, "modelId" | "reportedModelId">;

/** complete=false 或字段缺失不能作为自动积分结算的完整用量。 */
export interface ModelMetering {
  source: "sdk_model_usage";
  complete: boolean;
  /** 含按消息累计、没等到 SDK 结算消息的用量(取消、失败、多轮中断) */
  partial?: boolean;
  models: ModelTokenUsage[];
  /**
   * 观察到了、但没带模型名的用量(不在 models 里),四项分开记,不与 models 重叠。
   * 结算时这部分按本次运行主模型的售价计;不能拿总 token 减去 models 来推算 ——
   * 各来源的总数口径不同(有的含缓存,有的不含)。
   */
  unattributed?: TokenBreakdown;
}

const nonNeg = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);

/** 读出未归属模型的用量(库里读回的数据也按这个口径校验);没有或全为 0 返回 null */
export function unattributedOf(m: Pick<ModelMetering, "unattributed"> | null | undefined) {
  const u = m?.unattributed as Partial<TokenBreakdown> | undefined;
  if (!u || typeof u !== "object") return null;
  const t: TokenBreakdown = {
    inputTokens: nonNeg(u.inputTokens),
    outputTokens: nonNeg(u.outputTokens),
    cacheReadTokens: nonNeg(u.cacheReadTokens),
    cacheWriteTokens: nonNeg(u.cacheWriteTokens),
  };
  return t.inputTokens || t.outputTokens || t.cacheReadTokens || t.cacheWriteTokens ? t : null;
}

/** 两份未归属用量相加;都没有返回 undefined */
export function addUnattributed(
  a: TokenBreakdown | null | undefined,
  b: TokenBreakdown | null | undefined,
): TokenBreakdown | undefined {
  if (!a && !b) return undefined;
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
    cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
  };
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
