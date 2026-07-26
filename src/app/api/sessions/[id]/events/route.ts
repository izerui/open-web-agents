import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * joinStream —— 重新挂上正在跑的运行。
 *
 * 刷新页面 / 断线重连时用它:先回放缓冲里的近期事件(noise 在前、state 在后)重建界面,
 * 再继续订阅后续事件。Redis pub/sub 不持久,没有这层回放,重连后就只剩空白。
 *
 * 若该会话已经跑完(缓冲里有终态 result),回放完直接收流,不吊着连接。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { bus, auth, replay } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const encoder = new TextEncoder();
  const topic = topicOf(id);

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

      // finish 需要在订阅建立之前就定义(要挂到 abort 上),故用可变容器持有退订函数
      const subscription: { off?: () => void } = {};
      const finish = () => {
        if (closed) return;
        closed = true;
        subscription.off?.();
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };
      req.signal.addEventListener("abort", finish, { once: true });

      const { events, done } = replay.replay(topic);

      if (done) {
        // 已跑完:回放完即收流
        for (const e of events) send(e);
        finish();
        return;
      }

      // 仍在跑:先订阅(避免回放与实时之间漏事件),再回放,然后继续实时推送
      subscription.off = bus.subscribe(topic, (e) => {
        send(e);
        if (e.kind === "result") finish();
      });
      await bus.ready?.(topic);
      for (const e of events) send(e);
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
