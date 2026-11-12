import { marketContext, marketError } from "@/app/api/market/_lib/context";
import { MARKET_CATEGORIES } from "@/lib/modules/market/domain/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * 审核一条上架申请。
 * body `{ action: "approve", category }` —— 复用管理员上架的同一逻辑上架到该类别;
 * body `{ action: "reject", reason }` —— 理由必填,所有者在构建页看得到。
 */
export async function POST(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const ctx = await marketContext(req);
    const decided = await ctx.requests.decide(
      ctx.principal,
      id,
      await req.json().catch(() => null),
    );
    const agent = await ctx.agents.get(decided.agentId);
    await ctx.audit.record({
      actor: ctx.principal,
      action: decided.status === "approved" ? "market.listing_approve" : "market.listing_reject",
      resource: { type: "agent", id: decided.agentId },
      ownerId: agent?.ownerId,
      details: {
        name: agent?.name ?? decided.agentId,
        requestId: decided.id,
        version: decided.version,
        ...(decided.category
          ? {
              category: decided.category,
              categoryName: MARKET_CATEGORIES.find((c) => c.id === decided.category)?.name,
            }
          : {}),
        ...(decided.reason ? { reason: decided.reason } : {}),
      },
      req,
    });
    return Response.json({ request: decided });
  } catch (error) {
    return marketError(error);
  }
}
