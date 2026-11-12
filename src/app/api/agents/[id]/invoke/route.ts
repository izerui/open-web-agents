import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { acceptInvoke } from "../../_lib/invoke-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 对外触发接口:第三方系统(Java/Go/Python/C)调这里跑一次智能体。
 * 需要 `X-Api-Key`(或 `Authorization: Bearer`)。
 *
 * 与网页对话共用同一运行内核 —— 只是入站 adapter 与结果投递方式不同
 * (设计文档 §3 统一接口原则)。异步返回 taskId,结果用 GET result 轮询。
 *
 * 路径段命名注记:设计文档把 URL 定为 /api/agents/{agentId}/invoke 与
 * /api/agents/{taskId}/result —— 同一层两种语义。Next 的文件路由不允许同层用不同 slug 名,
 * 故统一用 [id],URL 与文档保持一致,语义由各路由自述(此处 id = agentId)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params;
  const { auth } = getContainer();

  /*
   * 关卡顺序:
   *   鉴权与权限复查(每个请求都要过,重放也不例外 —— 吊销的 Key 拿不回任何东西)
   *   → 请求形状与摘要 → 幂等重放
   *   → 【只对新请求】限流、版本解析、契约校验、入队(入队时冻结积分、检查月度上限)。
   * 额度(以及之后的调用限流)只约束"新开一次运行";重放不产生新的执行和花费,
   * 拦它只会让调用方拿不回已经受理、甚至已经扣过费的任务。
   */
  let principal: Awaited<ReturnType<typeof auth.requireApiKey>>;
  try {
    principal = await auth.requireApiKey(req);
    await auth.assertCanInvoke(principal, agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  // 之后的关卡(请求形状、幂等重放、限流、版本、契约、入队)见共享的受理核心
  return acceptInvoke(req, agentId, principal, "invoke");
}
