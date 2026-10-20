import { asModelAdmin } from "../../../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 停用前查看影响:直接引用与经别名引用该模型的智能体数,以及指向它的别名。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asModelAdmin(req, async ({ c }) =>
    Response.json(await c.modelAdmin.impact({ capabilityId: id })),
  );
}
