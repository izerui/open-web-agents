import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { listingRequestsOf, marketError } from "@/app/api/market/_lib/context";
import { getContainer } from "@/lib/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * 上架申请(A13,所有者端;构建页「发布」阶段调用)。
 * 只有所有者与管理员能申请和查看;看不到这个智能体的人照常 404,不确认它存在。
 */
export async function GET(req: Request, { params }: Context) {
  const { id } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;
  try {
    const latest = await listingRequestsOf(getContainer()).latest(
      opened.principal,
      opened.subject,
      opened.agent,
    );
    return Response.json({ request: latest }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return marketError(error);
  }
}

/** body `{ note?: string }`;版本取当前发布版 */
export async function POST(req: Request, { params }: Context) {
  const { id } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;
  const container = getContainer();
  try {
    const created = await listingRequestsOf(container).submit(
      opened.principal,
      opened.subject,
      opened.agent,
      await req.json().catch(() => null),
    );
    await container.audit.record({
      actor: opened.principal,
      action: "market.listing_request",
      resource: { type: "agent", id },
      ownerId: opened.agent.ownerId,
      details: { name: opened.agent.name, version: created.version, note: created.note },
      req,
    });
    return Response.json({ request: created }, { status: 201 });
  } catch (error) {
    return marketError(error);
  }
}
