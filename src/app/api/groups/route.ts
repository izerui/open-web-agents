import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 列出组。
 * 普通用户看自己建的;admin 看全部(需要能维护他人建的组)。
 * 顺带回成员数 —— 列表页要显示,免得前端为每个组再发一次请求。
 */
export async function GET(req: Request) {
  const { groups, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAssistants(principal);
    const isAdmin = principal.type === "web" && principal.role === "admin";
    const userId = principal.type === "web" ? principal.userId : principal.ownerId;

    const list = await groups.list(isAdmin ? undefined : userId);
    const withCounts = await Promise.all(
      list.map(async (g) => ({ ...g, memberCount: (await groups.members(g.id)).length })),
    );
    return Response.json({ groups: withCounts, canViewAll: isAdmin });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 建组。建者即 owner,只有 owner 与 admin 能管理它。 */
export async function POST(req: Request) {
  const { groups, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAssistants(principal);
    const userId = principal.type === "web" ? principal.userId : principal.ownerId;

    const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string };
    if (!body.name?.trim()) return Response.json({ error: "name is required" }, { status: 400 });

    const g = await groups.create({
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      ownerId: userId,
    });
    return Response.json({ group: g }, { status: 201 });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
