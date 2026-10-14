import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { readEvalRun } from "@/lib/modules/eval/application/eval-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 一次评测的进度与各用例结果。读的时候给已结束的运行判分(见 readEvalRun)。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { evalDeps } = getContainer();
  const r = await readEvalRun(evalDeps, runId);
  // 只能看本智能体的评测
  if (!r || r.run.agentId !== id) return apiError(404, "not_found", "eval run not found");
  return Response.json(r);
}
