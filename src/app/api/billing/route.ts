import { type LedgerRefs, ledgerRefIds } from "@/features/billing/ledger-note";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { monthStartUtc } from "@/lib/modules/billing/application/run-charging";
import { BillingError } from "@/lib/modules/billing/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { auth, billing, users, runCharges, packages } = getContainer();
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
    const [balance, ledger, used] = await Promise.all([
      billing.balance(account.id),
      billing.ledger(account.id, { limit, cursor: query.get("cursor") ?? undefined }),
      runCharges.monthUsageByAccount(since, account.id),
    ]);
    // 流水「说明」要写成可读的句子:带回本页用到的运行(智能体名、来源)与订单(套餐名)
    const ids = ledgerRefIds(ledger.items);
    const [runInfo, orders] = await Promise.all([
      ids.runIds.length
        ? runCharges.describeRuns(account.id, ids.runIds)
        : Promise.resolve(new Map()),
      Promise.all(ids.orderIds.map((id) => packages.getOrder(id))),
    ]);
    const refs: LedgerRefs = { runs: Object.fromEntries(runInfo), orders: {} };
    for (const order of orders) {
      // 只带本账号的订单
      if (order && order.accountId === account.id)
        refs.orders[order.id] = { packageName: order.packageName };
    }
    return Response.json(
      {
        balance,
        ...ledger,
        refs,
        paymentsConnected: false,
        month: {
          since,
          usedMicroCredits: (used.get(account.id) ?? 0n).toString(),
          limitMicroCredits: account.monthlyLimitMicroCredits ?? null,
          // 旧美元上限待管理员按积分重新设置:暂不能发起运行
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
