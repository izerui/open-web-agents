import { asModelAdmin, jsonBody } from "../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 每个别名有几个智能体在用(草稿或当前发布版本);保存默认路由前给管理员看影响面。 */
export async function GET(req: Request) {
  return asModelAdmin(req, async ({ c }) =>
    Response.json({ usage: await c.modelAdmin.aliasUsage() }),
  );
}

/** 别名 fable/opus/sonnet/haiku → 同一提供者下已启用的文本模型。 */
export async function PUT(req: Request) {
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    const aliases = await c.modelAdmin.saveAliases(body, actorId);
    await c.audit.record({
      actor: principal,
      action: "model.alias_update",
      resource: { type: "model_aliases", id: "default" },
      ownerId: actorId,
      details: {
        providerId: aliases.providerId,
        fable: aliases.fable,
        opus: aliases.opus,
        sonnet: aliases.sonnet,
        haiku: aliases.haiku,
      },
      req,
    });
    return Response.json({ aliases });
  });
}
