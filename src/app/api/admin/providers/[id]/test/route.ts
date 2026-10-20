import { asModelAdmin, jsonBody } from "../../../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用一个模型发最小请求测试文本接入。连不上也回 200,结果在 ok 里。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const result = await c.modelAdmin.testConnection(id, {
      modelId: body.modelId,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    await c.audit.record({
      actor: principal,
      action: "provider.test",
      resource: { type: "model_provider", id },
      ownerId: actorId,
      details: { ok: result.ok, status: result.status ?? null },
      req,
    });
    return Response.json({ result });
  });
}
