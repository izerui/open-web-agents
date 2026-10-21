/** 一份按输入、输出、缓存读、缓存写分开的 token 用量 */
export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type TokenField = keyof TokenBreakdown;
export const TOKEN_FIELDS: readonly TokenField[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
];

export interface ModelTokenUsage extends TokenBreakdown {
  modelId: string;
  /** SDK 的原始标签可能包含上下文窗口后缀;价格匹配使用 SDK 提供的 canonicalModel。 */
  reportedModelId?: string;
  /**
   * 这份(累计)明细里读不出的计数项:对应的值只是已知部分(合并累计快照时保留此前确认的值),
   * 计量缺失已计入 ModelMetering.missing
   */
  missingFields?: TokenField[];
}

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
  /** 未归属用量里读不出的计数项(含义同 ModelTokenUsage.missingFields) */
  unattributedMissing?: TokenField[];
  /**
   * 计量缺失:读不出来的计数项数(字段缺失、不是非负整数,或整项不是对象)。
   * 有它就不能当成已完整计价 —— 能算出的部分照常扣,结算保持暂记。
   */
  missing?: number;
  /**
   * 这份计量只算这一条 result 自己的用量(取自它的 usage,或它没带计量时此前按消息观察到的用量),
   * 不是 modelUsage 的累计快照。一轮里合并多条 result 时据此决定逐条相加还是沿用最后一份。
   */
  fromResultUsage?: boolean;
}

/**
 * 读一个 API 风格(snake_case)的 token 计数:
 * - 非负安全整数 → 该值(0 是有效的零);
 * - 没给(undefined / null,缓存两项常常省略或给 null)→ 0,不算异常;
 * - 给了但读不出(负数、字符串、小数、超范围等)→ "missing",由调用方记为计量缺失,不能当零结清。
 */
export function readTokenCount(v: unknown): number | "missing" {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : "missing";
}

/** 读出计量缺失的项数(库里读回的数据也按这个口径校验) */
export function missingOf(m: Pick<ModelMetering, "missing"> | null | undefined): number {
  const v = m?.missing;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
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

/** 两份按模型的明细按模型相加(不改动入参) */
export function addModels(a: ModelTokenUsage[], b: ModelTokenUsage[]): ModelTokenUsage[] {
  const out = new Map<string, ModelTokenUsage>();
  for (const m of [...a, ...b]) {
    const cur = out.get(m.modelId);
    out.set(
      m.modelId,
      cur
        ? {
            ...cur,
            inputTokens: cur.inputTokens + m.inputTokens,
            outputTokens: cur.outputTokens + m.outputTokens,
            cacheReadTokens: cur.cacheReadTokens + m.cacheReadTokens,
            cacheWriteTokens: cur.cacheWriteTokens + m.cacheWriteTokens,
            ...unionFields(cur.missingFields, m.missingFields),
          }
        : { ...m },
    );
  }
  return [...out.values()];
}

const unionFields = (a?: readonly TokenField[], b?: readonly TokenField[]) => {
  const fields = [...new Set([...(a ?? []), ...(b ?? [])])];
  return fields.length > 0 ? { missingFields: fields } : {};
};

/** 已记下读不出字段的项数(按模型的 + 未归属的);计量缺失里超出它的是没有身份可追的 */
const trackedMissing = (m: ModelMetering) =>
  m.models.reduce((n, u) => n + (u.missingFields?.length ?? 0), 0) +
  (m.unattributedMissing?.length ?? 0);

/**
 * 把一份计量的缺失状态叠到另一份上,数量不动:按模型的读不出字段并到同一模型(没有就留一条数量为 0 的记录),
 * 未归属的标记取并集,没有身份可追的缺失项数相加。用于被后来的累计快照覆盖了数量的单轮结果 ——
 * 数量已含在新快照里,缺失状态却不能随之消失。
 */
export function withMissingMarks(base: ModelMetering, marks: ModelMetering): ModelMetering {
  const models = base.models.map((m) => ({ ...m }));
  for (const u of marks.models) {
    if (!u.missingFields?.length) continue;
    const cur = models.find((m) => m.modelId === u.modelId);
    if (cur) Object.assign(cur, unionFields(cur.missingFields, u.missingFields));
    else models.push({ ...u, ...ZERO, missingFields: [...u.missingFields] });
  }
  const unattributedMissing = [
    ...new Set([...(base.unattributedMissing ?? []), ...(marks.unattributedMissing ?? [])]),
  ];
  const out: ModelMetering = {
    ...base,
    models,
    ...(unattributedMissing.length ? { unattributedMissing } : {}),
  };
  const untracked =
    Math.max(0, missingOf(base) - trackedMissing(base)) +
    Math.max(0, missingOf(marks) - trackedMissing(marks));
  const missing = trackedMissing(out) + untracked;
  return { ...out, complete: base.complete && missing === 0, ...(missing > 0 ? { missing } : {}) };
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

/** 合法的模型标识:非空、不超过 200 字符 */
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;

/** 合法的计数:非负安全整数;否则 null(无法读取) */
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/**
 * SDK result.modelUsage 按真实模型给出本次 query 累计计量,包括子代理。
 *
 * 某一项不合规时不整项丢弃 —— 那样其中合法的计数也跟着丢了,结算少扣还会被当成结清:
 * - 模型身份认不出(标识为空或过长,也没有可用的 canonicalModel):合法的计数记进未归属用量,
 *   结算按本次运行主模型的价格计;
 * - 某个计数字段缺失或不是非负整数:读得出的照常计,读不出的记一项"计量缺失"(missing),
 *   结算据此不当成已完整计价(能算的先扣,保持暂记);
 * - 整项都不是对象:整项计为计量缺失。
 */
export function extractModelUsage(raw: unknown): ModelMetering {
  const out: ModelMetering = { source: "sdk_model_usage", complete: true, models: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ...out, complete: false, missing: 1 };
  const fields = {
    inputTokens: "inputTokens",
    outputTokens: "outputTokens",
    cacheReadTokens: "cacheReadInputTokens",
    cacheWriteTokens: "cacheCreationInputTokens",
  } as const;
  let missing = 0;
  let unattributed: TokenBreakdown | undefined;
  const unattributedMissing = new Set<TokenField>();
  for (const [modelId, value] of Object.entries(raw)) {
    const tokens: TokenBreakdown = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const bad: TokenField[] = [];
    let v: Record<string, unknown> = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // 整项读不出:模型名合法就保留这个模型、四项都标读不出(合并累计快照时保留此前确认的值)
      missing += 1;
      if (!validId(modelId)) continue;
      bad.push(...TOKEN_FIELDS);
    } else {
      v = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(fields) as [TokenField, string][]) {
        const c = count(v[field]);
        if (c === null) {
          missing += 1;
          bad.push(key);
        } else tokens[key] = c;
      }
    }
    const canonical = validId(v.canonicalModel)
      ? v.canonicalModel
      : validId(modelId)
        ? modelId
        : null;
    if (canonical === null) {
      unattributed = addUnattributed(unattributed, tokens);
      for (const f of bad) unattributedMissing.add(f);
      continue;
    }
    out.models.push({
      modelId: canonical,
      ...(validId(modelId) && canonical !== modelId ? { reportedModelId: modelId } : {}),
      ...tokens,
      ...(bad.length > 0 ? { missingFields: bad } : {}),
    });
  }
  if (unattributedOf({ unattributed })) out.unattributed = unattributed;
  if (unattributedMissing.size > 0) out.unattributedMissing = [...unattributedMissing];
  if (missing > 0) out.missing = missing;
  // 没有模型明细、有认不出的或读不出的:都不是完整计量。没有明细也不能证明本次没有消耗,留给结算层核对
  if (out.models.length === 0 || out.unattributed || missing > 0) out.complete = false;
  return out;
}

/**
 * 按字段合并两份累计快照(modelUsage 是整个 query 的累计值,不能相加)。收费数量与缺失状态分开处理:
 *
 * 数量 —— 只取新快照(它覆盖到此为止的全部):
 * - 同一模型读得出的字段:采用新值;
 * - 同一模型读不出的字段:保留此前已确认的值(累计值只增不减,取两者较大,不相加);
 * - 未归属用量(多个认不出模型的项的合计,身份对不上):只取新快照的,读不出的字段也不拿旧值补;
 * - 新快照没提到的模型 / 未归属用量:不沿用旧数量 —— 后来的明细可能已把它归到别的模型
 *   (例如修正了模型名),再加上旧数量就重复收费。
 *
 * 缺失状态 —— "没再提到"不等于"已经补齐":
 * - 新快照没提到、此前有读不出字段的模型:数量清零,读不出的标记照样沿用;
 * - 未归属部分、此前认不出身份且整项读不出的:没有身份,后来的快照无法证明已补齐,缺失一律沿用;
 * - 只有后来的快照对同一模型明确给出对应字段的合法值才解除。
 * 计量缺失的项数 = 新快照自己的 + 沿用下来的。
 */
export function mergeCumulative(prev: ModelMetering, next: ModelMetering): ModelMetering {
  const pick = (
    before: TokenBreakdown | undefined,
    after: TokenBreakdown,
    bad: readonly TokenField[] | undefined,
  ): TokenBreakdown => {
    const outT = { ...after };
    for (const f of bad ?? []) outT[f] = Math.max(after[f], before?.[f] ?? 0);
    return outT;
  };
  const prevById = new Map(prev.models.map((m) => [m.modelId, m]));
  const models: ModelTokenUsage[] = next.models.map((m) => {
    const merged = pick(prevById.get(m.modelId), m, m.missingFields);
    prevById.delete(m.modelId);
    return { ...m, ...merged };
  });
  // 新快照没提到的模型:不沿用数量(可能已含在新明细里);有读不出字段的,留一条数量为 0 的记录承载缺失标记
  let carried = 0;
  for (const m of prevById.values()) {
    if (!m.missingFields?.length) continue;
    models.push({ ...m, ...ZERO, missingFields: m.missingFields });
    carried += m.missingFields.length;
  }

  // 未归属用量是多个认不出模型的项的合计,两份快照之间对不上是哪一部分(旧的可能已归到新明细的某个模型):
  // 数量只取新快照的,读不出的字段也不拿旧值补 —— 否则可能把已含在新明细里的数量再收一次
  const unattributed = unattributedOf(next) ?? undefined;
  // 缺失标记:旧的未归属部分没有身份,后来的快照无法证明它已补齐,一律沿用(与新快照的标记合并)
  const unattributedMissing = [
    ...new Set([...(next.unattributedMissing ?? []), ...(prev.unattributedMissing ?? [])]),
  ];
  carried += prev.unattributedMissing?.length ?? 0;

  // 此前认不出身份、整项读不出的:没有身份可供后来的快照补齐,沿用其缺失
  const trackedPrev =
    prev.models.reduce((n, m) => n + (m.missingFields?.length ?? 0), 0) +
    (prev.unattributedMissing?.length ?? 0);
  carried += Math.max(0, missingOf(prev) - trackedPrev);

  const missing = missingOf(next) + carried;
  return {
    ...next,
    complete: next.complete && missing === 0,
    models,
    ...(unattributed && unattributedOf({ unattributed }) ? { unattributed } : {}),
    ...(unattributedMissing?.length ? { unattributedMissing } : {}),
    ...(missing > 0 ? { missing } : {}),
  };
}

const ZERO: TokenBreakdown = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
