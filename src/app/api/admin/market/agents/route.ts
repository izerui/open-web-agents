import { marketContext, marketError } from "@/app/api/market/_lib/context";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";
import { MARKET_CATEGORIES } from "@/lib/modules/market/domain/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 市场上架管理列表:全部已发布智能体(与 `/api/market?manage=true` 同一来源与权限),
 * 另附所有者邮箱、是否公开、待审申请 —— 这些是管理员判断「该不该上架」要看的,
 * 不进公开的市场接口(市场摘要按白名单只给使用方需要的字段)。
 *
 * unpublished:还没发布的智能体(最近 200 个里的),只给名称、所有者与是否公开 ——
 * 界面列出来并禁用上架,管理员看得出「为什么它不能上架」。
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
    const emailOf = async (ownerId: string) => {
      if (!emails.has(ownerId)) {
        emails.set(ownerId, (await ctx.users.get(ownerId).catch(() => null))?.email);
      }
      return emails.get(ownerId);
    };
    const isPublic = (id: string) =>
      grants.some((g) => g.resourceId === id && g.principalType === "*");
    const out = await Promise.all(
      items.map(async (item) => {
        const agent = await ctx.agents.get(item.id);
        const ownerId = agent?.ownerId;
        return {
          ...item,
          ownerEmail: ownerId ? await emailOf(ownerId) : undefined,
          isPublic: isPublic(item.id),
          pendingRequestId: pending.get(item.id),
        };
      }),
    );
    const unpublished = await Promise.all(
      (await ctx.agents.list())
        .filter((a) => !a.publishedVersion && !isSystemAgent(a.id))
        .map(async (a) => ({
          id: a.id,
          name: a.name,
          icon: a.icon,
          ownerEmail: await emailOf(a.ownerId),
          isPublic: isPublic(a.id),
        })),
    );
    return Response.json(
      { items: out, unpublished, categories: MARKET_CATEGORIES },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketError(error);
  }
}
