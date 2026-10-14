import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { parseCaseBody } from "../../_lib/case-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; caseId: string }> };

/** 只能改 / 删本智能体的用例:拿别的智能体的用例 id 来不行 */
async function ownCase(id: string, caseId: string) {
  const c = await getContainer().evals.getCase(caseId);
  return c && c.agentId === id ? c : null;
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id, caseId } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  if (!(await ownCase(id, caseId))) return apiError(404, "not_found", "case not found");
  const parsed = parseCaseBody(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.reason);
  await getContainer().evals.updateCase(caseId, parsed.value);
  return Response.json({ case: await getContainer().evals.getCase(caseId) });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id, caseId } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  if (!(await ownCase(id, caseId))) return apiError(404, "not_found", "case not found");
  await getContainer().evals.deleteCase(caseId);
  return Response.json({ deleted: caseId });
}
