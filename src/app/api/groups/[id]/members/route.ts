import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 只有组 owner 与 admin 能改成员 ——
 * 否则任何被分享过组内资源的人都能往组里塞人、间接扩大授权范围。
 */
async function requireGroupAdmin(req: Request, groupId: string) {
  const { groups, auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  auth.assertCanManageAssistants(principal);

  const group = await groups.get(groupId);
  // 无权时与"不存在"同样返回 404,不确认资源存在
  if (!group) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const isAdmin = principal.type === "web" && principal.role === "admin";
  const userId = principal.type === "web" ? principal.userId : principal.ownerId;
  if (!isAdmin && group.ownerId !== userId) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  return { group };
}

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
    return Response.json({ members: await groups.members(id) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
