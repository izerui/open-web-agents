import { asModelAdmin } from "../../../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 停用前查看影响:有多少智能体(草稿或发布版本)会用到该提供者的模型。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c }) =>
    Response.json(await c.modelAdmin.impact({ providerId: id })),
  );
}
