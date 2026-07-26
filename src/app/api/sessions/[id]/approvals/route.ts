import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出该会话的待审批请求。归属校验后才给看 —— 待审内容含命令与路径。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { approval, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    return Response.json({ pending: await approval.listPending(id) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface Body {
  approvalId?: string;
  decision?: "approved" | "denied";
  message?: string;
}

/**
 * 裁决一条待审请求。
 * 只有对会话有访问权的人能裁决 —— 否则任何人都能替别人批准危险操作。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { approval, auth } = getContainer();

  let by = "unknown";
  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    by = principal.type === "web" ? principal.userId : principal.keyId;
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.approvalId) return Response.json({ error: "approvalId is required" }, { status: 400 });
  if (body.decision !== "approved" && body.decision !== "denied") {
    return Response.json({ error: "decision must be approved/denied" }, { status: 400 });
  }

  // 只能裁决属于本会话的请求,防止拿别会话的 id 越权批准
  const pending = await approval.listPending(id);
  if (!pending.some((p) => p.id === body.approvalId)) {
    return Response.json({ error: "该待审请求不存在或已失效" }, { status: 404 });
  }

  const ok = await approval.resolve(
    body.approvalId,
    body.decision === "approved"
      ? { decision: "approved", by }
      : { decision: "denied", by, message: body.message },
  );
  if (!ok) return Response.json({ error: "该待审请求已失效" }, { status: 409 });

  return Response.json({ resolved: body.approvalId, decision: body.decision });
}
