import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { extractEmbedToken, verifyEmbedToken } from "@/lib/modules/integration/domain/embed-token";
import { PromptTooLarge, assertPromptSize } from "@/lib/modules/run/application/enqueue";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import { assertWithinQuota, quotaErrorResponse } from "@/lib/modules/usage/application/quota-guard";
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
  const { runs, bus, env, sessions, users, usage, enqueuer } = getContainer();

  const token = extractEmbedToken(req.headers);
  const claims = token ? verifyEmbedToken(env.sessionSecret, token) : null;
  if (!claims) {
    return Response.json({ error: "invalid or expired embed token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  try {
    assertPromptSize(prompt);
  } catch (err) {
    if (err instanceof PromptTooLarge) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }

  const sessionId = claims.sessionId;
  const session = await sessions.get(sessionId);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  /*
   * 额度关卡。embed 曾经完全没有 —— 浏览器里的访客可以在令牌有效期内无限发起运行,
   * 花费记在签发 key 的账号上却不受它的额度约束。
   */
  if (session.billingUserId) {
    try {
      await assertWithinQuota({ users, usage }, session.billingUserId);
    } catch (err) {
      const quota = quotaErrorResponse(err);
      if (quota) return quota;
      throw err;
    }
  }

  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AgentEvent, eventId?: string) => {
        if (closed) return;
        const idLine = eventId ? `id: ${eventId}\n` : "";
        try {
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      let stopWatch = () => {};
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

      const unsubscribe = bus.subscribe(
        topicOf(sessionId, runId),
        (e, eventId) => {
          send(e, eventId);
          if (e.kind === "result") finish();
        },
        { afterId: "0-0" },
      );
      req.signal.addEventListener("abort", finish, { once: true });

      try {
        // 等订阅生效再入队,避免 worker 抢先发出的首批事件丢失。
        // 总线故障不阻止提交 —— 队列在 MySQL,任务照常执行,只是没有实时过程。
        let busUsable = true;
        try {
          await bus.ready?.();
        } catch {
          busUsable = false;
          send({ kind: "status", label: "事件通道不可用,本次无实时过程", state: "degraded" });
        }
        await enqueuer.enqueue({ runId, sessionId, prompt });
        send({ kind: "status", label: "已入队", state: "pending" });
        stopWatch = watchTerminal(runs, runId, (e) => {
          send(e);
          finish();
        });

        // 总线不可用时已知收不到事件,立即收流,别让客户端白等到超时。
        // status 用 unknown 而非 success —— 此刻任务才刚入队,结局根本还不知道,
        // 发 success 等于把「我不知道」渲染成绿色对勾(见 types.ts 对该字段的说明)。
        if (!busUsable) {
          send({
            kind: "result",
            status: "unknown",
            summary: "任务已提交,但事件通道不可用 —— 请稍后轮询结果接口查看结局",
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
