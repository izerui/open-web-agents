// 终态兜底:定期查数据库,运行已落终态而事件流里迟迟没有 result 时,由这里补一条。
//
// 【为什么需要】SSE 与阻塞请求原本只靠事件总线上的 result 事件收尾,而事件投递是
// 尽力而为的(Redis 抖动时发布失败会被吞掉)。那条事件一丢,流式请求一直挂着、
// 阻塞请求永不返回 —— 而结果早就在库里了。终态以数据库为准,事件只是更快的通知。

import type { AgentEvent, RunState } from "@/lib/shared";

export interface TerminalSource {
  getResult(id: string): Promise<{
    status: RunState;
    structured: unknown;
    finalText: string | null;
    error: unknown;
  } | null>;
}

type ResultEvent = Extract<AgentEvent, { kind: "result" }>;

function isTerminal(s: RunState): s is "success" | "failed" | "cancelled" {
  return s === "success" || s === "failed" || s === "cancelled";
}

/** 把库里的终态翻成与总线上同形的 result 事件。 */
export function resultEventFromRow(
  runId: string,
  row: {
    status: "success" | "failed" | "cancelled";
    structured: unknown;
    finalText: string | null;
    error: unknown;
  },
): ResultEvent {
  const errMsg = (row.error as { message?: string } | null)?.message;
  return {
    kind: "result",
    status: row.status,
    structured: row.structured ?? undefined,
    summary: row.finalText ?? errMsg ?? undefined,
    runId,
  };
}

/**
 * 开始盯一条运行。到终态时调用一次 onTerminal 并自行停止。返回取消函数。
 * 第一次查询也要等一个间隔 —— 正常情况下总线上的事件会先到,不该抢在它前面。
 *
 * 【查询不重叠】上一次查询返回(或被放弃)之后才排下一次。曾经用 setInterval 每个间隔发一次,
 * 数据库不返回时挂住的查询每 3 秒多一条,积多了能把连接池占满。
 * 【单次查询有等待上限】超过 queryTimeoutMs 就放弃这次、照常排下一次 —— 数据库恢复后仍能收尾。
 * 放弃只是不再等,底层查询没有取消:最坏每个 queryTimeoutMs 积压一条,而不是每个间隔一条。
 */
export function watchTerminal(
  source: TerminalSource,
  runId: string,
  onTerminal: (e: ResultEvent) => void,
  intervalMs = 3_000,
  queryTimeoutMs = 10_000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  const tick = async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let row: Awaited<ReturnType<TerminalSource["getResult"]>> = null;
    try {
      row = await Promise.race([
        source.getResult(runId),
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => resolve(null), queryTimeoutMs);
        }),
      ]);
    } catch {
      row = null;
    } finally {
      clearTimeout(deadline);
    }
    if (stopped) return;
    if (row && isTerminal(row.status)) {
      stopped = true;
      onTerminal(resultEventFromRow(runId, { ...row, status: row.status }));
      return;
    }
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
