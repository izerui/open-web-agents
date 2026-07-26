import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { aggregateUsage } from "@/lib/modules/usage/domain/aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 90;

/**
 * 用量与成本看板数据。
 * 普通用户只看自己的;admin 看全平台(`?scope=all`)。
 */
export async function GET(req: Request) {
  const { usage, auth } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.resolveWeb>>;
  try {
    principal = await auth.resolveWeb(req);
    // 对外 key 不该看到平台运营数据
    auth.assertCanManageAssistants(principal);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), MAX_DAYS);
  const wantAll = url.searchParams.get("scope") === "all";

  const isAdmin = principal.type === "web" && principal.role === "admin";
  // 非 admin 请求全平台数据时静默降级为只看自己,而不是报错
  const ownerId = wantAll && isAdmin ? undefined : (principal as { userId: string }).userId;

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const [records, truncated] = await Promise.all([
    usage.list({ ownerId, since }),
    usage.isTruncated({ ownerId, since }),
  ]);

  return Response.json({
    days,
    scope: ownerId ? "self" : "all",
    canViewAll: isAdmin,
    queue: await usage.queueDepth(),
    // 结果被截断时必须说明 —— 否则「最新 5000 条的合计」会被当成总花费,
    // 而它只会偏小,超预算时反而没人察觉
    truncated,
    ...(truncated ? { truncatedNote: "记录数超过单次查询上限,以下为最近部分记录的合计" } : {}),
    ...aggregateUsage(records),
  });
}
