import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

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
  const { runs, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { runId?: string };

  // 指定 runId 就只取消那一个;否则取消该会话里所有未完成的运行
  const targets = body.runId
    ? [body.runId]
    : (await runs.listBySession(id))
        .filter((r) => r.status === "pending" || r.status === "running")
        .map((r) => r.id);

  const cancelled: string[] = [];
  for (const runId of targets) {
    if (await runs.cancel(runId)) cancelled.push(runId);
  }

  return Response.json({
    cancelled,
    // 如实告知延迟,别让界面在点下去的瞬间就宣称"已停止"
    note:
      cancelled.length > 0
        ? "已标记取消;正在执行的运行会在下一次心跳(最多 15 秒)内中止"
        : "没有可取消的运行(都已结束)",
  });
}
