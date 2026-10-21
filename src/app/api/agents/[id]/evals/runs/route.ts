import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { contentHash, parseVersion, snapshotOf } from "@/lib/modules/agent/domain/release";
import { startEvalRun } from "@/lib/modules/eval/application/eval-runner";
import { casesHash } from "@/lib/modules/eval/domain/release-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 最近的评测。每次评测标出它对应的内容:与当前草稿相同(matchesDraft)、与哪些版本相同
 * (matchesVersions,按内容摘要比对,不按发起时选的目标);casesChanged = 之后用例有改动或无法核对
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { evals, releases } = getContainer();
  const [runs, versions, cases] = await Promise.all([
    evals.listRuns(id, 20),
    releases.list(id),
    evals.listCases(id),
  ]);
  const draftHash = contentHash(snapshotOf(opened.agent));
  const current = casesHash(cases);
  return Response.json({
    runs: runs.map((r) => ({
      ...r,
      matchesDraft: r.configHash === draftHash,
      matchesVersions: versions
        .filter((v) => r.configHash !== undefined && v.contentHash === r.configHash)
        .map((v) => v.version),
      casesChanged: r.casesHash === undefined || r.casesHash !== current,
    })),
  });
}

/**
 * 发起一次评测:body { target: "draft" | 版本号 },对该版本跑一遍全部用例。
 * 会真正调用模型、产生费用:记在发起人名下。每个用例入队时各自冻结积分;
 * 积分或月度上限不够的用例记为"没能发起运行",不影响已发起的。
 * 只在有人点了才跑 —— 没有自动触发。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { evalDeps, audit } = getContainer();
  const userId = opened.subject.userId;

  const body = (await req.json().catch(() => ({}))) as { target?: unknown };
  let target: "draft" | number = "draft";
  if (body.target !== undefined && body.target !== "draft") {
    const n = parseVersion(body.target);
    if (!n.ok || n.value === undefined) {
      return apiError(400, "invalid_request", 'target 须为 "draft" 或正整数版本号');
    }
    target = n.value;
  }

  const r = await startEvalRun(evalDeps, { agentId: id, target, userId });
  if (!r.ok)
    return apiError(r.status, r.status === 404 ? "not_found" : "invalid_request", r.reason);

  await audit.record({
    actor: opened.principal,
    action: "eval.run",
    resource: { type: "agent", id },
    ownerId: opened.agent.ownerId,
    details: { evalRunId: r.run.id, target: String(target), cases: r.run.total },
    req,
  });
  return Response.json({ run: r.run }, { status: 202 });
}
