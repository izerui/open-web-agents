import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { PENDING_REASONS, type PendingReason } from "@/lib/modules/billing/run-charge-ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 所有账号的待核对(暂记)计费记录,只读。
 * ?reason=owed|usage_unknown|unpriced  ?limit=1~100  ?cursor=
 * 同时返回各原因的条数(不按 reason 筛选)。
 */
export async function GET(req: Request) {
  try {
    const { auth, runCharges } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const q = new URL(req.url).searchParams;
    const reason = q.get("reason") || undefined;
    if (reason && !(PENDING_REASONS as readonly string[]).includes(reason)) {
      return Response.json({ error: "reason 取值无效" }, { status: 400 });
    }
    const limit = q.has("limit") ? Number(q.get("limit")) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Response.json({ error: "limit 须为 1~100 的整数" }, { status: 400 });
    }
    let page: Awaited<ReturnType<typeof runCharges.listPending>>;
    try {
      page = await runCharges.listPending({
        reason: reason as PendingReason | undefined,
        limit,
        cursor: q.get("cursor") ?? undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "cursor 无效") {
        return Response.json({ error: "cursor 无效" }, { status: 400 });
      }
      throw err;
    }
    const counts = await runCharges.pendingCounts();
    return Response.json({ ...page, counts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
