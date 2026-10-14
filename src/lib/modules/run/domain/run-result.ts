// 对外的运行结果契约:/result 轮询、阻塞模式(stream:false)、webhook 三处同一份字段。
//
// 【为什么统一】三处曾各拼各的:/result 有 agentVersion 没有起止时间;阻塞模式的 error 是字符串、
// 没有 agentVersion;webhook 只有 summary 没有 text / done。集成方换一种取结果的方式就要改解析代码,
// 而且"结构化结果是从文本里捞出来的"这条降级信号(salvaged)哪里都看不到。
// 三处都从同一行数据库记录、经同一个函数组装 —— 数据库是结果的唯一真相。

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
  cost: { usd?: number; input: number; output: number; partial?: boolean } | null;
  /** ISO 时间;未开始 / 未结束为 null */
  startedAt: string | null;
  endedAt: string | null;
}

const DONE: ReadonlySet<string> = new Set(["success", "failed", "cancelled"]);

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
    cost: (r.cost as RunResult["cost"]) ?? null,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}
