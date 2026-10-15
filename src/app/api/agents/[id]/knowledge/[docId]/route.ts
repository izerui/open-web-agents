import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { agentAccessLevel } from "@/lib/modules/access/domain/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { id, docId } = await params;
  const { agents, grants, auth, knowledge } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const subject = await auth.subjectOf(principal);
    const agent = await agents.get(id);
    if (!agent) return Response.json({ error: "not found" }, { status: 404 });

    const access = agentAccessLevel(
      principal,
      agent,
      subject,
      await grants.listForResource("agent", id),
    );
    if (access === "none") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const doc = await knowledge.get(docId);
    if (!doc || doc.agentId !== id) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ id: doc.id, title: doc.title, content: doc.content });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
