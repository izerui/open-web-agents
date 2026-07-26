import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 轮询取结果:第三方系统 invoke 后用它拿最终产出。需要 API Key。
 *
 * - pending/running:还在跑,继续轮询
 * - success:structured 是按 outputSchema 校验过的 JSON(通用助手则为 null,只有 summary)
 * - failed:error 里带明确原因(含契约不符)
 *
 * 归属校验:只能读【自己发起】的任务 —— 光有同一助手的 key 也不行,
 * 否则同助手的两个对接方能互相读到对方的输入与产物。
 *
 * 此处路径段 id = taskId(见 invoke 路由里的命名注记)。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const { runs, auth } = getContainer();

  const run = await runs.getResult(taskId);
  if (!run) return Response.json({ error: "task not found" }, { status: 404 });

  try {
    const principal = await auth.requireApiKey(req);
    const owning = await runs.get(taskId);
    if (!owning) return Response.json({ error: "task not found" }, { status: 404 });
    await auth.assertSessionAccess(principal, owning.sessionId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const done = run.status === "success" || run.status === "failed" || run.status === "cancelled";

  return Response.json({
    taskId: run.id,
    status: run.status,
    done,
    structured: run.structured ?? null,
    cost: run.cost ?? null,
    error: run.error ?? null,
  });
}
