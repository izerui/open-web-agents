import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { requireGroupAdmin } from "../../_lib/group-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { groups } = getContainer();
  try {
    const r = await requireGroupAdmin(req, id);
    if (r.error) return r.error;
    return Response.json({ members: await groups.members(id) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 按邮箱加人。用户不存在时报错,避免把人加到打错的邮箱上却毫无提示。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { groups, users } = getContainer();
  try {
    const r = await requireGroupAdmin(req, id);
    if (r.error) return r.error;

    const body = (await req.json().catch(() => ({}))) as { email?: string };
    const email = body.email?.trim();
    if (!email) return Response.json({ error: "email is required" }, { status: 400 });

    const user = await users.findByEmail(email);
    if (!user) return Response.json({ error: `用户不存在:${email}` }, { status: 404 });

    await groups.addMember(id, user.id);
    // 加进组 = 获得组内所有分享;记在组主名下
    await getContainer().audit.record({
      actor: r.principal,
      action: "group.member_add",
      resource: { type: "group", id },
      ownerId: r.group.ownerId,
      details: { group: r.group.name, memberId: user.id, email: user.email },
      req,
    });
    return Response.json({ members: await groups.members(id) }, { status: 201 });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { groups } = getContainer();
  try {
    const r = await requireGroupAdmin(req, id);
    if (r.error) return r.error;

    const userId = new URL(req.url).searchParams.get("userId");
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });

    await groups.removeMember(id, userId);
    await getContainer().audit.record({
      actor: r.principal,
      action: "group.member_remove",
      resource: { type: "group", id },
      ownerId: r.group.ownerId,
      details: { group: r.group.name, memberId: userId },
      req,
    });
    return Response.json({ members: await groups.members(id) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
