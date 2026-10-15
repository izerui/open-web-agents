import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { BillingError } from "@/lib/modules/billing/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { auth, billing, users } = getContainer();
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
    const [balance, ledger] = await Promise.all([
      billing.balance(account.id),
      billing.ledger(account.id, { limit, cursor: query.get("cursor") ?? undefined }),
    ]);
    return Response.json(
      { balance, ...ledger, automaticCharging: false, paymentsConnected: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof BillingError)
      return Response.json(
        {
          error: err.message,
          code: err.code,
        },
        { status: err.status },
      );
    throw err;
  }
}
