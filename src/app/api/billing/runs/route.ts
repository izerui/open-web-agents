import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 账号的运行计费明细:每次运行受理时的模式、冻结、预计消耗与实际扣除。管理员可查任意账号。 */
export async function GET(req: Request) {
  try {
    const { auth, users, runCharges } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web") {
      return Response.json({ error: "集成 API Key 无权读取账号账务" }, { status: 403 });
    }
    const query = new URL(req.url).searchParams;
    const accountId = query.get("accountId") || principal.userId;
    if (accountId !== principal.userId) auth.assertCanAdministerPlatform(principal);
    const account = await users.get(accountId);
    if (!account) return Response.json({ error: "账号不存在" }, { status: 404 });
    const limit = query.has("limit") ? Number(query.get("limit")) : 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Response.json({ error: "limit 须为 1~100 的整数" }, { status: 400 });
    }
    let page: Awaited<ReturnType<typeof runCharges.listByAccount>>;
    try {
      page = await runCharges.listByAccount(account.id, {
        limit,
        cursor: query.get("cursor") ?? undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "cursor 无效") {
        return Response.json({ error: "cursor 无效" }, { status: 400 });
      }
      throw err;
    }
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
