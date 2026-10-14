import { openWebhookOwner } from "@/app/api/agents/_lib/webhook-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 该智能体的回调投递记录(新的在前,键集分页)。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openWebhookOwner(req, id);
  if (!opened.ok) return opened.res;
  const q = new URL(req.url).searchParams;
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return apiError(400, "invalid_request", "limit 须为 1~100 的整数");
  }
  return Response.json(
    await getContainer().webhookConsole.list(id, { cursor: q.get("cursor") ?? undefined, limit }),
  );
}
