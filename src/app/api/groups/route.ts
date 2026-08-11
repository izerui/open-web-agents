import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { ownerFilter, resolveScope } from "@/lib/modules/access/domain/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 列出组。
 *
 * `?scope=all` 才看全平台,且仅对 admin 生效;默认只看自己建的。
 *
 * 【为什么要显式 scope,而不是"是 admin 就给全部"】原来是后者,结果 admin
 * 根本没办法只看自己的组 —— 「我的组」这个页面对管理员会列出全平台的组,
 * 名不副实。范围该由调用方说清楚,而不是由身份隐式决定。
 *
 * 非 admin 请求 scope=all 静默降级为 self(不报错),与 /api/usage 口径一致:
 * 越权请求不值得给出"你不是管理员"这种额外信息。
 *
 * 顺带回成员数 —— 列表页要显示,免得前端为每个组再发一次请求。
 */
export async function GET(req: Request) {
  const { groups, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAssistants(principal);
    const isAdmin = principal.type === "web" && principal.role === "admin";
    const userId = principal.type === "web" ? principal.userId : principal.ownerId;

    const scope = resolveScope(new URL(req.url).searchParams.get("scope"), isAdmin);
    const list = await groups.list(ownerFilter(scope, userId));
    const withCounts = await Promise.all(
      list.map(async (g) => ({ ...g, memberCount: (await groups.members(g.id)).length })),
    );
    return Response.json({
      groups: withCounts,
      scope,
      canViewAll: isAdmin,
    });
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
