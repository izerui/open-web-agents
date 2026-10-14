import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 重新挂上正在执行的运行。Redis Stream ID 直接作为 SSE id,客户端可通过
 * Last-Event-ID 或 cursor 查询参数从任意 Web 实例继续读取。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { bus, auth, runs } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return Response.json({ error: "invalid request URL" }, { status: 400 });
  }
  const requestedRunId = url.searchParams.get("runId") ?? undefined;
  const cursor = req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursor") ?? "0-0";
  const rows = await runs.listBySession(id);
  const selected = requestedRunId
    ? rows.filter((run) => run.id === requestedRunId)
    : rows.filter((run) => run.status === "pending" || run.status === "running");

  if (selected.length === 0) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const pending = new Set(selected.map((run) => run.id));
      const subscriptions: (() => void)[] = [];

      const finish = () => {
        if (closed) return;
        closed = true;
        for (const unsubscribe of subscriptions) unsubscribe();
        try {
          controller.close();
        } catch {
          // 客户端已断开。
        }
      };

      const send = (event: AgentEvent, eventId?: string) => {
        if (closed) return;
        const idLine = eventId ? `id: ${eventId}\n` : "";
        try {
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          finish();
        }
      };

      req.signal.addEventListener("abort", finish, { once: true });

      try {
        await bus.ready?.();
        for (const run of selected) {
          const settleRun = () => {
            pending.delete(run.id);
            if (pending.size === 0) finish();
          };
          subscriptions.push(
            bus.subscribe(
              topicOf(id, run.id),
              (event, eventId) => {
                send(event, eventId);
                if (event.kind === "result") settleRun();
              },
              { afterId: cursor },
            ),
          );
          // 事件流过期(24h)或终态事件丢失时,由数据库终态收尾,而不是让连接一直挂着
          subscriptions.push(
            watchTerminal(runs, run.id, (e) => {
              if (!pending.has(run.id)) return;
              send(e);
              settleRun();
            }),
          );
        }
      } catch {
        send({
          kind: "result",
          status: "unknown",
          summary: "事件通道不可用,请稍后从运行结果接口查询结局",
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
    },
  });
}
