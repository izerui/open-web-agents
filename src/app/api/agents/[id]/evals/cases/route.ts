import { randomUUID } from "node:crypto";
import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { MAX_EVAL_CASES } from "@/lib/modules/eval/application/eval-runner";
import { parseCaseBody } from "../_lib/case-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 评测用例:标准输入 + 规则断言。只有能改这个智能体的人能看、能改 ——
 * 用例里常是真实的业务数据。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  return Response.json({ cases: await getContainer().evals.listCases(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { evals } = getContainer();

  const parsed = parseCaseBody(await req.json().catch(() => null));
  if (!parsed.ok) return apiError(400, "invalid_request", parsed.reason);
  if ((await evals.listCases(id)).length >= MAX_EVAL_CASES) {
    return apiError(409, "limit_exceeded", `每个智能体最多 ${MAX_EVAL_CASES} 个评测用例`);
  }
  const created = await evals.createCase({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    agentId: id,
    ...parsed.value,
    createdBy: opened.subject.userId,
  });
  return Response.json({ case: created }, { status: 201 });
}
