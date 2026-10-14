import { openWebhookOwner } from "@/app/api/agents/_lib/webhook-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 向当前回调地址发一条测试事件(event = "webhook.test",签名与正式回调相同),同步返回结果。
 * 投递失败也返回 200 —— 失败是这次测试的结果,不是接口出错;看 delivery.ok。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openWebhookOwner(req, id);
  if (!opened.ok) return opened.res;
  const { webhookConsole, audit } = getContainer();
  const r = await webhookConsole.sendTest(id);
  if (!r.configured) return apiError(409, "invalid_request", "该智能体还没有配置回调地址");
  await audit.record({
    actor: opened.principal,
    action: "webhook.test",
    resource: { type: "agent", id },
    ownerId: opened.agent.ownerId,
    details: { ok: r.delivery.ok, httpStatus: r.delivery.httpStatus },
    req,
  });
  return Response.json({ delivery: r.delivery });
}
