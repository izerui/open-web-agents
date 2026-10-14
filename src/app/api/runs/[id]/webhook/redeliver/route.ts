import { openWebhookOwner } from "@/app/api/agents/_lib/webhook-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手动重发某次运行的结果回调:放回发件箱,由投递器按正常流程(签名、退避重试)发出。
 * 只对会推回调的运行(接口调用、API 会话)开放;还在投递中的不重复入队。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runQuery, webhookConsole, audit, auth } = getContainer();
  try {
    await auth.resolveWeb(req); // 先鉴权,未登录不查库
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const run = await runQuery.detail(id);
  if (!run) return apiError(404, "not_found", "run not found");
  const opened = await openWebhookOwner(req, run.agentId);
  // 连这个智能体都看不到的人,一律当成运行不存在
  if (!opened.ok)
    return opened.res.status === 404 ? apiError(404, "not_found", "run not found") : opened.res;

  if (run.source !== "invoke" && run.source !== "api") {
    return apiError(409, "invalid_request", "只有接口调用与 API 会话的运行会推送回调");
  }
  if (!["success", "failed", "cancelled"].includes(run.status)) {
    return apiError(409, "invalid_request", "运行还没结束,结束后会自动推送回调");
  }
  if (!(await webhookConsole.redeliver(id))) {
    return apiError(409, "invalid_request", "这次回调正在投递中,稍后再看投递记录");
  }
  await audit.record({
    actor: opened.principal,
    action: "webhook.redeliver",
    resource: { type: "run", id },
    ownerId: opened.agent.ownerId,
    details: { agentId: run.agentId },
    req,
  });
  return Response.json({ requeued: true }, { status: 202 });
}
