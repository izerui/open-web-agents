import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { getContainer } from "@/lib/container";
import { estimateEvalCost } from "@/lib/modules/eval/domain/cost-estimate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 评测花费预估(gaps A9):跑之前告诉作者这一轮大概花多少积分。权限与评测用例一致(写权限)。
 *
 * 响应 `{ cases, model, samples, avgMicroCredits, totalMicroCredits }`:
 * 按草稿配置的主模型取近 30 天同模型已结算运行的平均实扣 × 用例数;
 * 没有样本时 avg/total 为 null(只说明会计费,不给数字)。规则见 eval/domain/cost-estimate.ts。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { evals, evalCostSamples } = getContainer();
  const model = opened.agent.config.model;
  const [cases, samples] = await Promise.all([
    evals.listCases(id),
    evalCostSamples.recentChargedMicro(id, model),
  ]);
  return Response.json(estimateEvalCost({ cases: cases.length, model, samples }));
}
