import { getContainer } from "@/lib/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 轮询取结果:第三方系统 invoke 后用它拿最终产出。
 *
 * - pending/running:还在跑,继续轮询
 * - success:structured 是按 outputSchema 校验过的 JSON(通用助手则为 null,只有 summary)
 * - failed:error 里带明确原因(含契约不符)
 *
 * 此处路径段 id = taskId(见 invoke 路由里的命名注记)。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const { runs } = getContainer();

  const run = await runs.getResult(taskId);
  if (!run) return Response.json({ error: "task not found" }, { status: 404 });

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
