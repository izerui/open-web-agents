import { getContainer } from "@/lib/container";

/**
 * 只有组 owner 与 admin 能改成员、删组 ——
 * 否则任何被分享过组内资源的人都能往组里塞人、间接扩大授权范围。
 */
export async function requireGroupAdmin(req: Request, groupId: string) {
  const { groups, auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  auth.assertCanManageAgents(principal);

  const group = await groups.get(groupId);
  // 无权时与"不存在"同样返回 404,不确认资源存在
  if (!group) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const isAdmin = principal.type === "web" && principal.role === "admin";
  const userId = principal.type === "web" ? principal.userId : principal.ownerId;
  if (!isAdmin && group.ownerId !== userId) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  return { group, principal };
}
