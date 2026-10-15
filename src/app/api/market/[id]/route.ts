import { marketContext, marketError } from "../_lib/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { market, principal, subject, grants } = await marketContext(req);
    return Response.json(
      {
        agent: await market.detail(
          principal,
          subject,
          await grants.listForResource("agent", id),
          id,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return marketError(error);
  }
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { market, principal, audit } = await marketContext(req);
    const result = await market.setListing(principal, id, await req.json().catch(() => null));
    await audit.record({
      actor: principal,
      action: "agent.update",
      resource: { type: "agent", id },
      details: { via: "market", changed: ["marketListed", "marketCategory"], ...result },
      req,
    });
    return Response.json(result);
  } catch (error) {
    return marketError(error);
  }
}
