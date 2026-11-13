import { marketContext, marketError } from "@/app/api/market/_lib/context";
import type { ListingRequest } from "@/lib/modules/market/listing-request-ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 上架申请队列(A13,管理端)。`?status=pending|approved|rejected`,不带则全部。
 * 每条附上智能体名、申请人邮箱、所有者邮箱、当前发布版与该版的评测结论,审核时不必再跳页查。
 */
export async function GET(req: Request) {
  try {
    const ctx = await marketContext(req);
    const list = await ctx.requests.list(
      ctx.principal,
      new URL(req.url).searchParams.get("status"),
    );
    return Response.json(
      { requests: await enrich(ctx, list) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketError(error);
  }
}

type Ctx = Awaited<ReturnType<typeof marketContext>>;

async function enrich(ctx: Ctx, list: ListingRequest[]) {
  const emails = new Map<string, string | undefined>();
  const emailOf = async (id: string) => {
    if (!emails.has(id)) emails.set(id, (await ctx.users.get(id).catch(() => null))?.email);
    return emails.get(id);
  };
  const agentIds = [...new Set(list.map((r) => r.agentId))];
  const agents = new Map(
    (await Promise.all(agentIds.map((id) => ctx.agents.get(id)))).flatMap((a) =>
      a ? [[a.id, a] as const] : [],
    ),
  );
  const published = await ctx.releases.publishedOf([...agents.values()]);
  // 公开(所有账号只读可见)与否:审核时要看,不必再跳到智能体列表查
  const publicIds = new Set(
    (await ctx.grants.listForType("agent"))
      .filter((g) => g.principalType === "*")
      .map((g) => g.resourceId),
  );
  return Promise.all(
    list.map(async (r) => {
      const agent = agents.get(r.agentId);
      const current = published.get(r.agentId);
      let evalState: string | undefined;
      let evalPassed: number | undefined;
      let evalTotal: number | undefined;
      // 评测结论读不到不影响审核(内存测试容器没有 releaseEvals,库里出错也一样)
      if (r.status === "pending" && current && ctx.releaseEvals) {
        const verdict = (
          await ctx.releaseEvals.verdicts(r.agentId, [current.contentHash]).catch(() => null)
        )?.get(current.contentHash);
        if (verdict) {
          evalState = verdict.state;
          if ("run" in verdict) {
            evalPassed = verdict.run.passed;
            evalTotal = verdict.run.total;
          }
        }
      }
      return {
        ...r,
        agentName: current?.name ?? agent?.name ?? r.agentId,
        agentIcon: current?.icon ?? agent?.icon,
        agentDescription: current?.description ?? agent?.description,
        requesterEmail: await emailOf(r.requesterId),
        ownerEmail: agent ? await emailOf(agent.ownerId) : undefined,
        publishedVersion: agent?.publishedVersion,
        marketListed: agent?.marketListed === true,
        isPublic: publicIds.has(r.agentId),
        /** 智能体当前的市场类别;旧申请没有申请类别时审核以它为默认。没有为 null */
        agentCategory: agent?.marketCategory ?? null,
        deleted: !agent,
        evalState,
        evalPassed,
        evalTotal,
      };
    }),
  );
}
