import { asModelAdmin, jsonBody } from "../../../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只能替换,不能读出;响应只回掩码。 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const { keyHint } = await c.modelAdmin.replaceKey(id, body.apiKey, actorId);
    await c.audit.record({
      actor: principal,
      action: "provider.key_replace",
      resource: { type: "model_provider", id },
      ownerId: actorId,
      req,
    });
    return Response.json({ keyHint });
  });
}
