import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { extractEmbedToken, verifyEmbedToken } from "@/lib/modules/integration/domain/embed-token";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * widget 发起一轮运行。
 *
 * 只认嵌入令牌,且【只能操作令牌绑定的那个会话】—— 会话 id 来自令牌本身而非请求体,
 * 所以拿到令牌也换不到别人的会话。
 */
export async function POST(req: Request) {
  const { runs, bus, env } = getContainer();

  const token = extractEmbedToken(req.headers);
  const claims = token ? verifyEmbedToken(env.sessionSecret, token) : null;
  if (!claims) {
    return Response.json({ error: "invalid or expired embed token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  const sessionId = claims.sessionId;
  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      const unsubscribe = bus.subscribe(topicOf(sessionId), (e) => {
        send(e);
        if (e.kind === "result") finish();
      });
      req.signal.addEventListener("abort", finish, { once: true });

      try {
        // 等订阅生效再入队,避免 worker 抢先发出的首批事件丢失。
        // 总线故障不阻止提交 —— 队列在 MySQL,任务照常执行,只是没有实时过程。
        let busUsable = true;
        try {
          await bus.ready?.(topicOf(sessionId));
        } catch {
          busUsable = false;
          send({ kind: "status", label: "事件通道不可用,本次无实时过程", state: "degraded" });
        }
        await runs.create({ id: runId, sessionId, prompt });
        send({ kind: "status", label: "已入队", state: "pending" });

        // 总线不可用时已知收不到事件,立即收流,别让客户端白等到超时
        if (!busUsable) {
          send({
            kind: "result",
            status: "success",
            summary: "任务已提交,但事件通道不可用 —— 请稍后查询结果",
          });
          finish();
        }
      } catch (err) {
        send({
          kind: "result",
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
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
