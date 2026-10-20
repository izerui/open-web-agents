// 没等到 SDK 结算消息(result)的那部分用量:按模型、按消息累计,供取消、失败、多轮中断时结算。
//
// SDK 的 result.modelUsage 是整个 query 的累计快照(scripts/sdk-probe/model-metering.mjs 实测),
// 所以每到一条 result,之前的消息都已被它覆盖 —— 这里只保留最后一条 result 之后的消息。
// 同一条消息会分多次到达(流式的 message_start / message_delta,以及最终的完整 assistant 消息),
// 按 messageId 取最后一份,不重复累计。

import type { RunResult } from "../ports";
import {
  type ModelMetering,
  type ModelTokenUsage,
  type TokenBreakdown,
  addUnattributed,
  missingOf,
  readTokenCount,
  unattributedOf,
} from "./model-usage";

type Field = "input" | "output" | "cacheRead" | "cacheWrite";

interface MessageUsage {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * 明确给出却读不出的计数(负数、字符串等;"usage" 表示整个 usage 不是对象)。
   * 同一条消息后来到达的那份把它读出来了就撤掉;最后仍在的记为计量缺失,不能当零结清
   */
  bad: Set<Field | "usage">;
}

type RawUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
};

const FIELDS: [Field, keyof RawUsage][] = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["cacheWrite", "cache_creation_input_tokens"],
];

/** 把一份计数并进消息:读得出的取最大(同一条消息的累计值),读不出的记下 */
function absorb(into: MessageUsage, field: Field, raw: unknown): void {
  const c = readTokenCount(raw);
  if (c === "missing") {
    into.bad.add(field);
    return;
  }
  into.bad.delete(field);
  into[field] = Math.max(into[field], c);
}

export type EngineCost = NonNullable<RunResult["cost"]>;

export class UnsettledUsage {
  private readonly byMessage = new Map<string, MessageUsage>();
  private readonly anonymous: MessageUsage[] = [];
  /** 流式时正在生成的消息(按所属子代理区分):message_delta 不带 id,靠它归属 */
  private readonly streaming = new Map<string, string>();

  /** 喂一条 SDK 原始消息 */
  observe(msg: unknown): void {
    const m = msg as {
      type?: string;
      parent_tool_use_id?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: RawUsage };
      event?: {
        type?: string;
        message?: { id?: unknown; model?: unknown; usage?: RawUsage };
        usage?: RawUsage;
      };
    } | null;
    if (!m) return;
    const parent = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : "";
    if (m.type === "assistant" && m.message?.usage) {
      this.put(m.message.id, m.message.model, m.message.usage);
    } else if (m.type === "stream_event" && m.event?.type === "message_start") {
      const id = m.event.message?.id;
      if (typeof id === "string") this.streaming.set(parent, id);
      this.put(id, m.event.message?.model, m.event.message?.usage ?? {});
    } else if (m.type === "stream_event" && m.event?.type === "message_delta" && m.event.usage) {
      const id = this.streaming.get(parent);
      const cur = id ? this.byMessage.get(id) : undefined;
      // message_delta 的 output_tokens 是这条消息到目前为止的累计
      if (cur) absorb(cur, "output", m.event.usage.output_tokens);
    }
  }

  private put(id: unknown, model: unknown, u: unknown): void {
    const prev = typeof id === "string" ? this.byMessage.get(id) : undefined;
    const next: MessageUsage = {
      model: typeof model === "string" && model ? model : prev?.model,
      input: prev?.input ?? 0,
      output: prev?.output ?? 0,
      cacheRead: prev?.cacheRead ?? 0,
      cacheWrite: prev?.cacheWrite ?? 0,
      bad: new Set(prev?.bad),
    };
    if (u && typeof u === "object" && !Array.isArray(u)) {
      next.bad.delete("usage");
      for (const [field, key] of FIELDS) absorb(next, field, (u as RawUsage)[key]);
    } else {
      next.bad.add("usage");
    }
    if (typeof id === "string") this.byMessage.set(id, next);
    else this.anonymous.push(next);
  }

  /** 收到 result:之前的都已被它的累计快照覆盖 */
  settled(): void {
    this.byMessage.clear();
    this.anonymous.length = 0;
    this.streaming.clear();
  }

  /** 尚未被 result 覆盖的部分用量;一点都没有返回 undefined */
  cost(): EngineCost | undefined {
    const all = [...this.byMessage.values(), ...this.anonymous].filter(
      (u) => u.input || u.output || u.cacheRead || u.cacheWrite || u.bad.size > 0,
    );
    if (all.length === 0) return undefined;
    const missing = all.reduce((k, u) => k + u.bad.size, 0);
    const byModel = new Map<string, ModelTokenUsage>();
    let unattributed: TokenBreakdown | undefined;
    let input = 0;
    let output = 0;
    for (const u of all) {
      input += u.input + u.cacheRead + u.cacheWrite;
      output += u.output;
      // 没带模型名的消息:四项分开单独记下(结算按主模型价计),不能丢,也不能混进总数里再去推算
      if (!u.model) {
        unattributed = addUnattributed(unattributed, {
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
        });
        continue;
      }
      const cur = byModel.get(u.model) ?? {
        modelId: u.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      cur.inputTokens += u.input;
      cur.outputTokens += u.output;
      cur.cacheReadTokens += u.cacheRead;
      cur.cacheWriteTokens += u.cacheWrite;
      byModel.set(u.model, cur);
    }
    return {
      input,
      output,
      partial: true,
      metering: {
        source: "sdk_model_usage",
        // 有认不出模型的部分:按模型的明细不完整(结算对这部分按主模型价计);有读不出的计数同样不完整
        complete: !unattributedOf({ unattributed }) && missing === 0,
        partial: true,
        models: [...byModel.values()],
        ...(unattributedOf({ unattributed }) ? { unattributed } : {}),
        ...(missing > 0 ? { missing } : {}),
      },
    };
  }
}

/**
 * 已结算的花费(最后一条 result 的累计快照)+ 之后尚未结算的部分用量。
 * 已结算的没有按模型的计量时,合起来也无法完整计价,标为不完整;它的总数记进未归属用量,
 * 否则一合并,结算就只看得到后来那部分的明细,前面的整段漏收。
 */
export function mergeCost(
  base: RunResult["cost"],
  extra: EngineCost | undefined,
): RunResult["cost"] {
  if (!extra) return base;
  if (!base) return extra;
  const models = new Map<string, ModelTokenUsage>();
  for (const m of [...(base.metering?.models ?? []), ...(extra.metering?.models ?? [])]) {
    const cur = models.get(m.modelId);
    models.set(
      m.modelId,
      cur
        ? {
            ...cur,
            inputTokens: cur.inputTokens + m.inputTokens,
            outputTokens: cur.outputTokens + m.outputTokens,
            cacheReadTokens: cur.cacheReadTokens + m.cacheReadTokens,
            cacheWriteTokens: cur.cacheWriteTokens + m.cacheWriteTokens,
          }
        : { ...m },
    );
  }
  // result 的总数不含缓存(input = usage.input_tokens),按普通输入、输出记
  const baseUnattributed =
    unattributedOf(base.metering) ??
    ((base.metering?.models?.length ?? 0) === 0 && (base.input > 0 || base.output > 0)
      ? {
          inputTokens: base.input,
          outputTokens: base.output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }
      : null);
  const unattributed = addUnattributed(baseUnattributed, unattributedOf(extra.metering));
  const missing = missingOf(base.metering) + missingOf(extra.metering);
  const metering: ModelMetering = {
    source: "sdk_model_usage",
    complete: base.metering?.complete === true && extra.metering?.complete === true,
    partial: true,
    models: [...models.values()],
    ...(unattributed ? { unattributed } : {}),
    ...(missing > 0 ? { missing } : {}),
  };
  return {
    ...base,
    input: base.input + extra.input,
    output: base.output + extra.output,
    partial: true,
    metering,
  };
}
