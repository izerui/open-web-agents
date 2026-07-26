import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 发起一轮运行:入队后由 worker 异步执行,本请求只负责把事件流转给客户端。
 *
 * 关键差别 —— 运行**不绑定在这个 HTTP 请求上**:客户端断开只是停止接收事件,
 * agent 仍在 worker 里跑完并落库,重新连 /events 可继续观察(joinStream)。
 *
 * 传输:裸 `data: <AgentEvent JSON>\n\n`。前端用 fetch + getReader 手工拆帧,
 * 而非原生 EventSource —— 后者带不了 Authorization 头。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, bus, sessions, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (!(await sessions.get(id))) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

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

      // 先订阅再入队,避免 worker 抢先跑完导致漏掉开头的事件
      const unsubscribe = bus.subscribe(topicOf(id), (e) => {
        // 【只认自己的终态】事件按会话广播,而同一会话可以并发跑多轮(API 侧很容易
        // 触发,队列也不按 session 串行化)。曾经是"收到任意 result 就收流",于是
        // 先跑完的那轮会把这条流提前关掉 —— 用户看到回答停在半截,
        // 并且再也收不到真正属于本轮的结果。
        if (e.kind === "result" && e.runId !== undefined && e.runId !== runId) return;
        send(e);
        if (e.kind === "result") finish();
      });

      req.signal.addEventListener("abort", finish, { once: true });

      try {
        // 等订阅在总线上真正生效再入队 —— 否则 worker 可能抢在订阅注册前就发出首批事件。
        //
        // 但总线故障【不该阻止提交任务】:队列在 MySQL,Redis 只管事件投递。
        // 因为看不到实时过程就连活都派不出去,是很糟的失败模式 ——
        // 降级为"任务照常入队执行,只是这次看不到流式过程"。
        let busUsable = true;
        try {
          await bus.ready?.(topicOf(id));
        } catch {
          busUsable = false;
          send({ kind: "status", label: "事件通道不可用,本次无实时过程", state: "degraded" });
        }
        await runs.create({ id: runId, sessionId: id, prompt });
        send({ kind: "status", label: "已入队", state: "pending" });

        // 总线不可用时【已知不会有事件到来】,再挂着连接只是让客户端白等到超时。
        // 立即收流并告知:任务已提交,请改用轮询取结果。
        //
        // 【状态不能写 success】—— 这一刻任务才刚入队,结果是什么根本不知道。
        // 曾经这里发的是 status:"success",事件形状与真正跑完的运行一模一样,
        // 于是客户端按 kind==="result" && status==="success" 记为成功、渲染绿色对勾,
        // 随之置 running=false 卸掉审批轮询 —— 后续的人工审批闸门再也不显示,
        // 十分钟后被自动拒绝。若该运行随后失败,用户早已被告知它成功了。
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
      // 挡住 nginx 等反代的响应缓冲,否则流式变成一次性返回
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
    },
  });
}
