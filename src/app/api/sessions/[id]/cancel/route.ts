import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { cancellableRunIds } from "@/lib/modules/run/domain/cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 取消会话内尚未落终态的运行。
 *
 * 【为什么必须有这个接口】—— 界面上的"停止"曾经只调 fetch 的 abort。但运行
 * **不绑定在那个 HTTP 请求上**(这是 /run 的刻意设计:客户端断开只是停止接收事件,
 * agent 仍在 worker 里跑完)。于是点停止之后:SSE 关闭、UI 显示已停止,而服务端
 * 继续调模型、继续执行工具、继续产生副作用(写文件、发请求)、继续扣费,
 * 直到 30 分钟墙钟上限或自然结束,最后落 success。
 *
 * 状态机里 pending/running --cancel--> cancelled 两条边一直写着,却没有任何生产者。
 *
 * 实现上只需一条 UPDATE:它复用栅栏机制 —— worker 续租要求 status='running'
 * 且令牌匹配,状态一改,下次心跳就返回 false,worker 据此中止并且不写回结果。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, auth, bus, cancelSignal } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { runId?: string };
  let sessionRuns = await runs.listBySession(id);
  // `/run` 的响应头可能在 ReadableStream.start 完成入队前到达。用户立即点停止时，
  // 给明确的 runId 一个短等待窗口，避免第一次查询为空后任务反而继续运行。
  for (
    let attempt = 0;
    body.runId && !sessionRuns.some((run) => run.id === body.runId) && attempt < 20;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    sessionRuns = await runs.listBySession(id);
  }
  const targets = cancellableRunIds(sessionRuns, body.runId);

  const cancelled: string[] = [];
  for (const runId of targets) {
    if (!(await runs.cancel(runId))) continue;
    // 落库之后立即通知执行它的 worker 停下,而不是等下一次心跳(最多 15 秒)
    await cancelSignal.publish(runId);
    cancelled.push(runId);
    // 取消是数据库里的真实终态，也要进入事件流。否则当前页面只能靠 abort 猜测，
    // 刷新后 transcript 又没有取消事件，最终只剩一条没有回答的用户消息。
    await bus
      .publish(topicOf(id, runId), {
        kind: "result",
        status: "cancelled",
        summary: "已停止",
        runId,
      })
      .catch(() => {});
  }

  return Response.json({
    cancelled,
    // 如实告知延迟,别让界面在点下去的瞬间就宣称"已停止"
    note:
      cancelled.length > 0
        ? "已取消;正在执行的运行会立即收到停止通知(通知丢失时最迟在下一次心跳、约 15 秒内中止)"
        : "没有可取消的运行(都已结束)",
  });
}
