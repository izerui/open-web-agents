// 对外的运行结果契约:/result 轮询、阻塞模式(stream:false)、webhook 三处同一份字段。
//
// 【为什么统一】三处曾各拼各的:/result 有 agentVersion 没有起止时间;阻塞模式的 error 是字符串、
// 没有 agentVersion;webhook 只有 summary 没有 text / done。集成方换一种取结果的方式就要改解析代码,
// 而且"结构化结果是从文本里捞出来的"这条降级信号(salvaged)哪里都看不到。
// 三处都从同一行数据库记录、经同一个函数组装 —— 数据库是结果的唯一真相。

import type { PublicCreditEstimate } from "@/lib/modules/usage/domain/public-estimate";
import type { RunState } from "@/lib/shared";

export interface RunRecord {
  id: string;
  status: RunState;
  structured: unknown;
  /** 结构化结果是从最终文本里提取的(SDK 没给原生 structured_output) */
  salvaged: boolean | null;
  finalText: string | null;
  cost: unknown;
  error: unknown;
  agentVersion: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface RunResult {
  taskId: string;
  status: RunState;
  /** 已落终态(success / failed / cancelled) */
  done: boolean;
  /** 实际执行的智能体版本;null = 草稿 */
  agentVersion: number | null;
  /** 符合 outputSchema 的结构化结果;未声明契约或未成功时为 null */
  structured: unknown;
  /** structured 是从最终文本里提取的,而非模型原生的结构化输出(兼容网关的降级路径) */
  salvaged: boolean;
  /** 最终回答文本 */
  text: string | null;
  error: { kind: string; message: string; status?: number } | null;
  cost: PublicRunCost | null;
  /** ISO 时间;未开始 / 未结束为 null */
  startedAt: string | null;
  endedAt: string | null;
}

const DONE: ReadonlySet<string> = new Set(["success", "failed", "cancelled"]);

/**
 * 对外可见的费用。库里的 cost 还有原始计量与估算(上游模型标识)和计价上下文(所属提供者),
 * 只留给结算与对账;对外按模型只给公开模型 id、名称、价目版本、token 与积分。
 */
export interface PublicRunCost {
  usd?: number;
  input: number;
  output: number;
  partial?: boolean;
  creditEstimate?: PublicCreditEstimate;
}

/**
 * 按白名单挑字段,而不是整份透传 —— 类型断言过滤不了字段,透传会把内部的提供者 id 与上游模型标识
 * 带给结果轮询、阻塞响应、webhook 与运行详情的调用方。按模型的明细只取结算时生成的公开版本。
 */
export function publicCost(raw: unknown): PublicRunCost | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  return {
    ...(typeof c.usd === "number" ? { usd: c.usd } : {}),
    input: Number(c.input ?? 0),
    output: Number(c.output ?? 0),
    ...(c.partial === true ? { partial: true } : {}),
    ...(c.publicEstimate ? { creditEstimate: c.publicEstimate as PublicCreditEstimate } : {}),
  };
}

export function toRunResult(r: RunRecord): RunResult {
  return {
    taskId: r.id,
    status: r.status,
    done: DONE.has(r.status),
    agentVersion: r.agentVersion,
    structured: r.structured ?? null,
    salvaged: r.salvaged === true,
    text: r.finalText,
    error: (r.error as RunResult["error"]) ?? null,
    cost: publicCost(r.cost),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}
