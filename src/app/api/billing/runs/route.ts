import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  isChargeSource,
  isSummaryWindow,
  summaryWindow,
} from "@/lib/modules/billing/domain/charge-summary";
import type { RunChargeFilter } from "@/lib/modules/billing/run-charge-ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 维度取值里 "none" 表示没有:智能体已不存在、网页发起没有 Key */
const idOrNone = (v: string) => (v === "none" ? null : v);

/**
 * 从消耗汇总点进来的筛选:window 加上 source / agentId / apiKeyId 之一。
 * 参数不合法返回字符串说明
 */
function filterOf(query: URLSearchParams): RunChargeFilter | string | undefined {
  const window = query.get("window");
  const source = query.get("source");
  const agentId = query.get("agentId");
  const apiKeyId = query.get("apiKeyId");
  if (window === null && source === null && agentId === null && apiKeyId === null) return undefined;
  const filter: RunChargeFilter = {};
  if (window !== null) {
    if (!isSummaryWindow(window)) return "window 无效";
    Object.assign(filter, summaryWindow(window, Date.now()));
  }
  if (source !== null) {
    if (!isChargeSource(source)) return "source 无效";
    filter.source = source;
  }
  for (const [name, v] of [
    ["agentId", agentId],
    ["apiKeyId", apiKeyId],
  ] as const) {
    if (v === null) continue;
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(v)) return `${name} 无效`;
    filter[name] = idOrNone(v);
  }
  return filter;
}

/** 账号的运行计费明细:每次运行的冻结、应扣与实际扣除。管理员可查任意账号。 */
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
    const filter = filterOf(query);
    if (typeof filter === "string") return Response.json({ error: filter }, { status: 400 });
    let page: Awaited<ReturnType<typeof runCharges.listByAccount>>;
    try {
      page = await runCharges.listByAccount(account.id, {
        limit,
        cursor: query.get("cursor") ?? undefined,
        filter,
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
