import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { requireGroupAdmin } from "../_lib/group-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 删除用户组(组的创建者或管理员)。
 *
 * 同时收回所有「授权给这个组」的智能体分享:组没了,经由它拿到的权限也不该留下 ——
 * 否则授权记录指向一个不存在的组,分享设置里出现无法辨认的条目。成员账号本身不受影响。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { groups, grants, audit } = getContainer();
  try {
    const r = await requireGroupAdmin(req, id);
    if (r.error) return r.error;

    const members = await groups.members(id);
    const viaGroup = (await grants.listForType("agent")).filter(
      (g) => g.principalType === "group" && g.principalId === id,
    );
    for (const g of viaGroup) await grants.revoke(g.id);
    await groups.delete(id);
    await audit.record({
      actor: r.principal,
      action: "group.delete",
      resource: { type: "group", id },
      ownerId: r.group.ownerId,
      details: { name: r.group.name, members: members.length, revokedGrants: viaGroup.length },
      req,
    });
    return Response.json({ ok: true, revokedGrants: viaGroup.length });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
