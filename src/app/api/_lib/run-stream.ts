// 运行事件流(SSE)的唯一实现:对话运行与分支重跑共用。
//
// 【为什么收成一处】这段"订阅 → 入队 → 数据库终态兜底 → 收流"曾在两个路由里各写一遍,
// 修一处漏一处(例如终态兜底、总线降级)。现在只有这一份。

import type { BusPort } from "@/lib/modules/events/ports";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { type TerminalSource, watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import type { AgentEvent } from "@/lib/shared";

export interface StreamRunOptions {
  bus: BusPort;
  /** 终态兜底:事件总线上的 result 丢了、或总线整个不可用,都由数据库终态收尾。 */
  results: TerminalSource;
  sessionId: string;
  runId: string;
  /** 入队(或报告已经发生的入队错误)。在订阅建立之后调用;订阅从 Stream 起点补读,先入队也不漏事件。 */
  enqueue: () => Promise<unknown>;
}

export function streamRun(req: Request, opts: StreamRunOptions): Response {
  const { bus, results, sessionId, runId, enqueue } = opts;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let stopWatch = () => {};
      let unsubscribe = () => {};

      const send = (e: AgentEvent, eventId?: string) => {
        if (closed) return;
        const idLine = eventId ? `id: ${eventId}\n` : "";
        try {
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        stopWatch();
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      unsubscribe = bus.subscribe(
        topicOf(sessionId, runId),
        (e, eventId) => {
          send(e, eventId);
          if (e.kind === "result") finish();
        },
        { afterId: "0-0" },
      );
      req.signal.addEventListener("abort", finish, { once: true });

      try {
        // 总线不可用时不再立刻回"结局未知":看不到实时过程,但结局仍会由数据库送达
        const busUsable = await Promise.resolve(bus.ready?.()).then(
          () => true,
          () => false,
        );
        if (!busUsable) {
          send({
            kind: "status",
            label: "事件通道不可用:看不到实时过程,运行结束后会显示结果",
            state: "degraded",
          });
        }
        await enqueue();
        send({ kind: "status", label: "已入队", state: "pending" });
        stopWatch = watchTerminal(results, runId, (e) => {
          send(e);
          finish();
        });
      } catch (err) {
        send({
          kind: "result",
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          runId,
        });
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
    },
  });
}
