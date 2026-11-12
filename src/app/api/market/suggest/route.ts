import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { type SuggestDoc, rankSuggestions } from "@/lib/modules/market/domain/suggest";
import { marketContext, marketError } from "../_lib/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 3;

const categoryName = (id: string | undefined) =>
  MARKET_CATEGORIES.find((c) => c.id === id)?.name ?? "";

/**
 * 探索首页「想交给它什么事」的推荐(gaps.md A1 第一版)。
 *
 * 候选 = 当前用户能用的已上架智能体 + 自己名下的智能体(标 mine)。按名称、说明、
 * 示例问题、类别做关键词打分(见 market/domain/suggest.ts),取前 3 个。不调模型。
 *
 * 市场条目只用发布版的公开字段(与 /api/market 同一份白名单);自己的智能体用草稿 ——
 * 所有者本来就能看、能跑自己的草稿。
 */
export async function GET(req: Request) {
  try {
    const { market, principal, subject, grants, agents } = await marketContext(req);
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length > 200) return Response.json({ error: "描述过长" }, { status: 400 });
    if (!q) return Response.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });

    const [listed, own] = await Promise.all([
      market.list(principal, subject, await grants.listForType("agent")),
      principal.type === "web" ? agents.list({ ownerId: subject.userId }) : Promise.resolve([]),
    ]);
    const mineIds = new Set(
      own.filter((a) => a.ownerId === subject.userId && !isSystemAgent(a.id)).map((a) => a.id),
    );

    type Item = {
      id: string;
      name: string;
      description: string | null;
      icon: string | null;
      category: string | null;
      publishedVersion: number | null;
      model: string | null;
      author: string | null;
      useCount: number;
      avgCredits: number | null;
      mine: boolean;
    };
    const items = new Map<string, Item>();
    const docs: SuggestDoc[] = [];
    const fromMarket = (m: MarketAgent) => {
      items.set(m.id, {
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        icon: m.icon ?? null,
        category: m.category,
        publishedVersion: m.publishedVersion ?? null,
        model: m.config.model ?? null,
        author: m.author,
        useCount: m.useCount,
        avgCredits: m.avgCredits,
        mine: mineIds.has(m.id),
      });
      docs.push({
        id: m.id,
        name: m.name,
        description: m.description ?? "",
        starters: m.config.starters ?? [],
        category: categoryName(m.category),
        mine: mineIds.has(m.id),
        useCount: m.useCount,
      });
    };
    for (const m of listed) fromMarket(m);
    for (const a of own) {
      if (!mineIds.has(a.id) || items.has(a.id)) continue;
      items.set(a.id, {
        id: a.id,
        name: a.name,
        description: a.description ?? null,
        icon: a.icon ?? null,
        category: a.marketCategory ?? null,
        publishedVersion: a.publishedVersion ?? null,
        model: a.config.model ?? null,
        author: null,
        useCount: 0,
        avgCredits: null,
        mine: true,
      });
      docs.push({
        id: a.id,
        name: a.name,
        description: a.description ?? "",
        starters: a.config.starters ?? [],
        category: categoryName(a.marketCategory),
        mine: true,
        useCount: 0,
      });
    }

    const ranked = rankSuggestions(q, docs, LIMIT);
    return Response.json(
      { items: ranked.flatMap((r) => items.get(r.id) ?? []) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketError(error);
  }
}
