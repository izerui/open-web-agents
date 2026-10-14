import { agentChanges } from "@/app/api/agents/_lib/audit-agent";
import { getContainer } from "@/lib/container";
import { designCaller, designError } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { principal, subject } = await designCaller(req);
    const { designer, audit } = getContainer();
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      previewToken?: string;
    };
    if (typeof body.sessionId !== "string")
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    const result = await designer.apply(subject, body.sessionId, body.previewToken);
    await audit.record({
      actor: principal,
      action: result.created ? "agent.create" : "agent.update",
      resource: { type: "agent", id: result.saved.id },
      ownerId: result.saved.ownerId,
      details: {
        name: result.saved.name,
        changed: agentChanges(result.before ?? null, result.saved),
        via: "designer",
        designSessionId: body.sessionId,
      },
      req,
    });
    return Response.json({ agent: result.agent, created: result.created });
  } catch (err) {
    return designError(err);
  }
}
