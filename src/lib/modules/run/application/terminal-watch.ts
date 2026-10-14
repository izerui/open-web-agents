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
 * 【同一时刻最多一条查询】上一次查询真正完成(返回或拒绝)之后才排下一次。
 * 曾经用 setInterval 每个间隔发一次,数据库不返回时挂住的查询每 3 秒多一条,积多了能把连接池占满。
 * 也不在这里设"等待超时就排下一次":超时只是不再等,底层查询并没有结束,照样会一条条积压下去。
 * 限时交给数据源:生产上用 BoundedResultReader,超时即销毁那条连接、底层查询真正结束后才拒绝,
 * 这里随即排下一次 —— 数据库卡死时每轮最多一条连接,恢复后照常收尾。
 */
export function watchTerminal(
  source: TerminalSource,
  runId: string,
  onTerminal: (e: ResultEvent) => void,
  intervalMs = 3_000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  const tick = () => {
    source.getResult(runId).then(
      (row) => {
        if (stopped) return;
        if (row && isTerminal(row.status)) {
          stopped = true;
          onTerminal(resultEventFromRow(runId, { ...row, status: row.status }));
          return;
        }
        schedule();
      },
      // 查询失败:这一条已经结束,下一轮照常查
      () => schedule(),
    );
  };

  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
