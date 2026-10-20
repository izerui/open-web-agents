import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { monthStartUtc } from "@/lib/modules/billing/application/run-charging";
import { BillingError } from "@/lib/modules/billing/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { auth, billing, users, billingMode, runCharges } = getContainer();
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
    const since = monthStartUtc(Date.now());
    const mode = await billingMode.get();
    const [balance, ledger, used] = await Promise.all([
      billing.balance(account.id),
      billing.ledger(account.id, { limit, cursor: query.get("cursor") ?? undefined }),
      runCharges.monthUsageByAccount(mode, since),
    ]);
    return Response.json(
      {
        balance,
        ...ledger,
        // 试算:运行照常进行,只记预计消耗,不动钱包;正式:受理冻结、结束按实际用量扣除
        mode,
        automaticCharging: mode === "live",
        paymentsConnected: false,
        month: {
          since,
          usedMicroCredits: (used.get(account.id) ?? 0n).toString(),
          limitMicroCredits: account.monthlyLimitMicroCredits ?? null,
          // 旧美元上限待管理员按积分重新设置:正式扣费下暂不能发起运行
          limitPending: account.legacyMonthlyLimitMicroUsd !== undefined,
        },
      },
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
