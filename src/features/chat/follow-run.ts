import type { AgentEvent } from "@/lib/shared";
import { readEventStream } from "./event-stream";

/** 复用 SSE 游标重连:设计与业务对话共用同一个运行内核。 */
export async function followRun(args: {
  sessionId: string;
  runId: string;
  push: (event: AgentEvent) => void;
  signal: AbortSignal;
  initial?: ReadableStream<Uint8Array> | null;
}): Promise<void> {
  let cursor = "0-0";
  let done = false;
  const onEvent = (event: AgentEvent) => {
    if (event.kind === "result") done = true;
    args.push(event);
  };
  const onCursor = (id: string) => {
    cursor = id;
  };
  if (args.initial) {
    try {
      await readEventStream(args.initial, onEvent, onCursor);
    } catch {
      if (args.signal.aborted) return;
    }
  }
  let lastError: unknown;
  for (let attempt = 0; !done && !args.signal.aborted && attempt <= 5; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4000)));
      if (args.signal.aborted) return;
    }
    try {
      const response = await fetch(
        `/api/sessions/${args.sessionId}/events?runId=${encodeURIComponent(args.runId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal: args.signal, cache: "no-store" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `重新连接运行失败(HTTP ${response.status})`);
      }
      if (!response.body) throw new Error("无响应流");
      await readEventStream(response.body, onEvent, onCursor);
      lastError = undefined;
    } catch (err) {
      if (args.signal.aborted) return;
      lastError = err;
    }
  }
  if (!done && !args.signal.aborted) {
    args.push({
      kind: "result",
      status: "unknown",
      runId: args.runId,
      summary: `连接中断${lastError instanceof Error ? `(${lastError.message})` : ""},运行可能仍在后台继续,请刷新查看`,
    });
  }
}
