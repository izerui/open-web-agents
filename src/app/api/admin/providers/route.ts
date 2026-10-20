import { asModelAdmin, jsonBody } from "../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提供者列表(含各类型模型数)与别名映射。Key 只返回掩码。 */
export async function GET(req: Request) {
  return asModelAdmin(req, async ({ c }) => Response.json(await c.modelAdmin.overview()));
}

/** 新建提供者,可同时填 API Key。 */
export async function POST(req: Request) {
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const provider = await c.modelAdmin.createProvider(
      { definition: body.definition, apiKey: body.apiKey },
      actorId,
    );
    await c.audit.record({
      actor: principal,
      action: "provider.create",
      resource: { type: "model_provider", id: provider.id },
      ownerId: actorId,
      details: {
        name: provider.name,
        kinds: Object.keys(provider.endpoints),
        withCredential: provider.hasKey,
      },
      req,
    });
    return Response.json({ provider }, { status: 201 });
  });
}
