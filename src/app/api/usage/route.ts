import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { ownerFilter, resolveScope } from "@/lib/modules/access/domain/scope";
import { aggregateUsage } from "@/lib/modules/usage/domain/aggregate";
import { estimateRunCredits } from "@/lib/modules/usage/domain/estimate";
import { toPublicEstimate } from "@/lib/modules/usage/domain/public-estimate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 90;

/**
 * 用量与成本看板数据。
 * 普通用户只看自己的;admin 看全平台(`?scope=all`)。
 */
export async function GET(req: Request) {
  const { usage, auth, capabilities, pricedModels } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.resolveWeb>>;
  try {
    principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), MAX_DAYS);

  const isAdmin = principal.type === "web" && principal.role === "admin";
  const scope = resolveScope(url.searchParams.get("scope"), isAdmin);
  const ownerId = ownerFilter(scope, (principal as { userId: string }).userId);

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const [records, truncated, catalog] = await Promise.all([
    usage.list({ ownerId, since }),
    usage.isTruncated({ ownerId, since }),
    capabilities.list(),
  ]);

  const runs = await Promise.all(
    records.map(async (r) => {
      const stored = r.creditEstimate;
      // 运行锁定的价目版本:没有快照时按它重算,对外映射模型名称也按它;更早的运行只能按当前目录
      const atRunPrice = await pricedModels.forRun(r.pricing);
      const estimated = stored ?? estimateRunCredits(r.metering, atRunPrice ?? catalog);
      // 对外只给公开模型 id 与名称,上游模型标识不出库
      const publicEstimate =
        r.publicEstimate ??
        toPublicEstimate(estimated, atRunPrice ?? catalog, r.pricing?.providerId);
      return {
        runId: r.runId,
        agentId: r.agentId,
        agentName: r.agentName,
        status: r.status,
        costMicroUsd: r.costMicroUsd,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        at: r.at,
        estimatedCredits: publicEstimate,
        estimateSource: stored
          ? ("run_snapshot" as const)
          : r.pricing && atRunPrice
            ? ("run_price_version" as const)
            : ("current_price" as const),
      };
    }),
  );

  return Response.json({
    days,
    scope,
    canViewAll: isAdmin,
    queue: await usage.queueDepth(),
    truncated,
    ...(truncated ? { truncatedNote: "记录数超过单次查询上限,以下为最近部分记录的合计" } : {}),
    ...aggregateUsage(records),
    runs,
    creditEstimateNote: "积分估算基于 SDK 用量快照与当前价目，尚未启用积分扣款",
  });
}
