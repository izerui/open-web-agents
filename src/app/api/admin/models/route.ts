import { asModelAdmin, jsonBody } from "../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 全部模型(含停用),附所属提供者名称。 */
export async function GET(req: Request) {
  return asModelAdmin(req, async ({ c }) =>
    Response.json({ models: await c.modelAdmin.listModels() }),
  );
}

/** 新建或修改模型:按成本价录入,售价由服务端派生;每次保存生成新版本。 */
export async function POST(req: Request) {
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const model = await c.modelAdmin.saveModel(
      { definition: body.definition, expectedVersion: body.expectedVersion ?? null },
      actorId,
    );
    await c.audit.record({
      actor: principal,
      action: "model.update",
      resource: { type: "model", id: model.id },
      ownerId: actorId,
      details: {
        name: model.name,
        kind: model.kind,
        providerId: model.providerId ?? null,
        version: model.version,
        enabled: model.enabled,
        markupBp: model.markupBp ?? null,
      },
      req,
    });
    return Response.json({ model }, { status: model.version === 1 ? 201 : 200 });
  });
}
