import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { PUBLIC_PRINCIPAL, hasResourceAccess } from "@/lib/modules/access/domain/grants";
import type { Principal } from "@/lib/modules/access/domain/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function subjectOf(p: Principal) {
  return p.type === "web" ? { userId: p.userId, role: p.role } : { userId: p.ownerId };
}

/**
 * 只有对助手有 write 权限的人才能改它的分享设置 ——
 * 否则被分享 read 的人可以把别人的助手再公开出去。
 */
async function requireWrite(req: Request, assistantId: string) {
  const { assistants, grants, auth } = getContainer();
  const subject = subjectOf(await auth.resolveWeb(req));
  const assistant = await assistants.get(assistantId);
  if (!assistant) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const list = await grants.listForResource("assistant", assistantId);
  // 连读都无权 → 404,不确认资源存在;能读但不能写 → 403
  if (!hasResourceAccess(subject, assistant, "read", list)) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (!hasResourceAccess(subject, assistant, "write", list)) {
    return { error: Response.json({ error: "no write permission" }, { status: 403 }) };
  }
  return { subject, assistant, list };
}

/** 查看某助手当前的分享设置。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await requireWrite(req, id);
    if (r.error) return r.error;
    return Response.json({ grants: r.list });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface ShareBody {
  /** "public" 表示公开给所有登录用户;否则是目标用户邮箱。 */
  target?: string;
  permission?: "read" | "write";
}

/** 新增/更新一条分享。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { grants, users } = getContainer();

  try {
    const r = await requireWrite(req, id);
    if (r.error) return r.error;

    const body = (await req.json().catch(() => ({}))) as ShareBody;
    const permission = body.permission === "write" ? "write" : "read";
    const target = body.target?.trim();
    if (!target) return Response.json({ error: "target is required" }, { status: 400 });

    if (target === "public") {
      const g = await grants.grant({
        id: randomUUID().replace(/-/g, "").slice(0, 24),
        resourceType: "assistant",
        resourceId: id,
        principalType: "*",
        principalId: PUBLIC_PRINCIPAL,
        permission,
      });
      return Response.json({ grant: g }, { status: 201 });
    }

    // 按邮箱分享:先确认用户存在,避免授权给打错的邮箱后静默无效
    const user = await users.findByEmail(target);
    if (!user) return Response.json({ error: `用户不存在:${target}` }, { status: 404 });

    const g = await grants.grant({
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      resourceType: "assistant",
      resourceId: id,
      principalType: "user",
      principalId: user.id,
      permission,
    });
    return Response.json({ grant: g, email: user.email }, { status: 201 });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 撤销一条分享。 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { grants } = getContainer();
  try {
    const r = await requireWrite(req, id);
    if (r.error) return r.error;

    const grantId = new URL(req.url).searchParams.get("grantId");
    if (!grantId) return Response.json({ error: "grantId is required" }, { status: 400 });

    // 只允许撤销本助手上的授权,防止拿别的资源的 grantId 越权删除
    if (!r.list.some((g) => g.id === grantId)) {
      return Response.json({ error: "grant not found on this assistant" }, { status: 404 });
    }
    await grants.revoke(grantId);
    return Response.json({ revoked: grantId });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
