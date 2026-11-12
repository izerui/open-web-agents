import { marketContext, marketError } from "@/app/api/market/_lib/context";
import { MARKET_CATEGORIES } from "@/lib/modules/market/domain/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 市场上架管理列表:全部已发布智能体(与 `/api/market?manage=true` 同一来源与权限),
 * 另附所有者邮箱、是否公开、待审申请 —— 这些是管理员判断「该不该上架」要看的,
 * 不进公开的市场接口(市场摘要按白名单只给使用方需要的字段)。
 */
export async function GET(req: Request) {
  try {
    const ctx = await marketContext(req);
    const grants = await ctx.grants.listForType("agent");
    const items = await ctx.market.list(ctx.principal, ctx.subject, grants, { manage: true });
    const pending = new Map(
      (await ctx.listingRequests.list({ status: "pending", limit: 500 })).map((r) => [
        r.agentId,
        r.id,
      ]),
    );
    const emails = new Map<string, string | undefined>();
    const out = await Promise.all(
      items.map(async (item) => {
        const agent = await ctx.agents.get(item.id);
        const ownerId = agent?.ownerId;
        if (ownerId && !emails.has(ownerId)) {
          emails.set(ownerId, (await ctx.users.get(ownerId).catch(() => null))?.email);
        }
        return {
          ...item,
          ownerEmail: ownerId ? emails.get(ownerId) : undefined,
          isPublic: grants.some((g) => g.resourceId === item.id && g.principalType === "*"),
          pendingRequestId: pending.get(item.id),
        };
      }),
    );
    return Response.json(
      { items: out, categories: MARKET_CATEGORIES },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketError(error);
  }
}
