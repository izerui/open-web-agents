import { MARKET_CATEGORIES } from "@/lib/modules/market/domain/catalog";
import { marketContext, marketError } from "./_lib/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { market, principal, subject, grants } = await marketContext(req);
    const params = new URL(req.url).searchParams;
    const search = params.get("q") ?? "";
    if (search.length > 200) return Response.json({ error: "搜索词过长" }, { status: 400 });
    const items = await market.list(principal, subject, await grants.listForType("agent"), {
      search,
      category: params.get("category") || undefined,
      manage: params.get("manage") === "true",
    });
    return Response.json(
      { items, categories: MARKET_CATEGORIES },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return marketError(error);
  }
}
