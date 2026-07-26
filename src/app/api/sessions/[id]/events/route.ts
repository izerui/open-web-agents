import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { replayScopeOf, topicOf } from "@/lib/modules/run/application/orchestrator";
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

      /**
       * 顺序必须是:订阅 → 等订阅生效 → 再取回放快照。
       *
       * 曾经是先取快照、后订阅。注释写着"先订阅避免漏事件",代码却相反 ——
       * 而且 Redis 的 SUBSCRIBE 要一个来回才真正生效(await bus.ready)。
       * 这个窗口内发布的事件既不在快照里、也不在实时订阅里,永久丢失;
       * 丢的若是 result 事件,finish() 就永远不会被调用,连接一直挂着,
       * 而 replay 之后一直返回 done:false,再怎么重连也还是挂着。
       *
       * 订阅先行的代价是可能重复推同一条事件(快照里有、实时又来一次)——
       * 重复远比丢失好:前端能容忍重复渲染,容忍不了永久挂起。
       */
      const live: AgentEvent[] = [];
      let replayed = false;

      /**
       * joinStream 关心的是整个会话,所以要等【所有】在跑的运行都收尾才收流。
       *
       * 曾经是"收到任意 result 就收流":同会话并发两轮时,先跑完那轮的终态会把
       * 这条重连流关掉,另一轮的过程就此断在半截,而且刷新也拿不回来
       * (那时缓冲还按会话存,后开始的一轮 reset 已经把前一轮的记录删干净了)。
       */
      const pending = new Set<string>();
      const onResult = (e: AgentEvent) => {
        if (e.kind !== "result") return;
        if (e.runId) {
          pending.delete(e.runId);
          if (pending.size === 0) finish();
          return;
        }
        // 不带 runId 的运行(adhoc / 旧事件)按原语义:见到终态即收流
        finish();
      };

      subscription.off = bus.subscribe(topic, (e) => {
        // 快照还没发出去之前先攒着,免得实时事件插到历史事件前面
        if (!replayed) {
          live.push(e);
          return;
        }
        send(e);
        onResult(e);
      });
      await bus.ready?.(topic);

      // 合并该会话下所有运行的缓冲 —— 缓冲按 run 分桶,一个会话可能有多桶
      const { events, done, open } = replay.replayScope(replayScopeOf(id));
      for (const o of open) pending.add(o);
      for (const e of events) send(e);
      replayed = true;

      // 补发订阅生效后、快照取出前到达的事件
      for (const e of live) {
        send(e);
        onResult(e);
      }

      // 该会话下已知的运行全部跑完:回放完即收流,不吊着连接
      if (done) finish();
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
