import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type SummaryDimension,
  isSummaryDimension,
  isSummaryWindow,
  summaryWindow,
  totalOf,
} from "@/lib/modules/billing/domain/charge-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单个账号能按的维度;全平台(管理员)把"按 Key"换成"按账号" */
const ACCOUNT_DIMENSIONS: SummaryDimension[] = ["source", "agent", "key"];
const PLATFORM_DIMENSIONS: SummaryDimension[] = ["source", "agent", "account"];

/**
 * 消耗汇总:按来源、智能体、API Key 归组的积分消耗。
 * 默认看自己的账号;管理员可传 accountId 看任意账号,或 scope=all 看全平台。
 */
export async function GET(req: Request) {
  try {
    const { auth, users, runCharges } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web") {
      return Response.json({ error: "集成 API Key 无权读取账号账务" }, { status: 403 });
    }
    const query = new URL(req.url).searchParams;
    const window = query.get("window") ?? "this_month";
    if (!isSummaryWindow(window)) {
      return Response.json({ error: "window 无效" }, { status: 400 });
    }
    const by = query.get("by") ?? "source";
    const platform = query.get("scope") === "all";
    let accountId: string | undefined;
    if (platform) {
      auth.assertCanAdministerPlatform(principal);
    } else {
      accountId = query.get("accountId") || principal.userId;
      if (accountId !== principal.userId) auth.assertCanAdministerPlatform(principal);
      if (!(await users.get(accountId))) {
        return Response.json({ error: "账号不存在" }, { status: 404 });
      }
    }
    if (
      !isSummaryDimension(by) ||
      !(platform ? PLATFORM_DIMENSIONS : ACCOUNT_DIMENSIONS).includes(by)
    ) {
      return Response.json({ error: "by 无效" }, { status: 400 });
    }
    const { since, until } = summaryWindow(window, Date.now());
    const rows = await runCharges.summarize({ accountId, since, until, by });
    return Response.json(
      { window, since, until, by, rows, total: totalOf(rows) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
