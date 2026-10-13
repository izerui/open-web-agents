import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canAccessSession } from "@/lib/modules/access/domain/principal";
import { topicOf } from "@/lib/modules/run/application/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 按运行 id 取消。集成方手里只有 taskId —— 曾经必须先拿到 sessionId 才能调会话级的取消接口。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { auth, runQuery, runs, bus, cancelSignal } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const run = await runQuery.detail(id);
    const allowed =
      run &&
      canAccessSession(principal, { id: run.sessionId, agentId: run.agentId, ...run.ownership })
        .allowed;
    if (!run || !allowed) return apiError(404, "not_found", "run not found");

    if (!(await runs.cancel(id))) {
      return Response.json({ cancelled: false, status: run.status, note: "运行已结束,无需取消" });
    }
    await cancelSignal.publish(id);
    await bus
      .publish(topicOf(run.sessionId, id), {
        kind: "result",
        status: "cancelled",
        summary: "已停止",
        runId: id,
      })
      .catch(() => {});
    return Response.json({ cancelled: true });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
