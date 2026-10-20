import { asModelAdmin, jsonBody } from "../../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c }) =>
    Response.json({ provider: await c.modelAdmin.getProvider(id) }),
  );
}

/** 修改名称、启用状态、各类型接入地址。带 expectedVersion,冲突 409。 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const before = await c.modelAdmin.getProvider(id);
    const provider = await c.modelAdmin.updateProvider(
      id,
      { definition: body.definition, expectedVersion: body.expectedVersion },
      actorId,
    );
    const changed = (["name", "enabled", "endpoints"] as const).filter(
      (f) => JSON.stringify(before[f]) !== JSON.stringify(provider[f]),
    );
    await c.audit.record({
      actor: principal,
      action: "provider.update",
      resource: { type: "model_provider", id },
      ownerId: actorId,
      details: { changedFields: changed, enabled: provider.enabled },
      req,
    });
    return Response.json({ provider });
  });
}
