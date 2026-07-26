import { getContainer } from "@/lib/container";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
// agent 可能跑很久,禁止静态化与响应缓冲
export const dynamic = "force-dynamic";

/**
 * 发起一轮运行,并以 SSE 流式回传归一后的过程事件。
 *
 * 传输格式:裸 `data: <AgentEvent JSON>\n\n`。
 * 前端用 fetch + getReader 手工拆帧(而非原生 EventSource)——后者无法带 Authorization 头。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orchestrator, bus, sessions } = getContainer();

  if (!(await sessions.get(id))) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // 客户端断开(关页面/取消 fetch)→ 中断 agent,避免孤儿进程继续烧钱
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const unsubscribe = bus.subscribe(topicOf(id), send);

      orchestrator
        .execute({ sessionId: id, prompt }, abort.signal)
        .catch((err: unknown) => {
          send({
            kind: "result",
            status: "failed",
            summary: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          unsubscribe();
          closed = true;
          try {
            controller.close();
          } catch {
            // 客户端已断开,忽略
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 挡住 nginx 等反代的响应缓冲,否则流式变成一次性返回
      "X-Accel-Buffering": "no",
    },
  });
}
