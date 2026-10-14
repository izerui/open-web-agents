import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import type { Principal } from "@/lib/modules/access/domain/principal";
import type { Agent } from "@/lib/modules/agent/ports";

/**
 * 回调的投递记录、测试、重发:只给智能体所有者与平台管理员,且只限网页登录。
 * 与"谁能设置回调地址"同一条规则 —— 投递记录里有回调地址与结果状态,协作者与 API Key 都不该看。
 */
export async function openWebhookOwner(
  req: Request,
  agentId: string,
): Promise<{ ok: true; agent: Agent; principal: Principal } | { ok: false; res: Response }> {
  const opened = await openAgent(req, agentId, "read");
  if (!opened.ok) return opened;
  const { principal, subject, agent } = opened;
  const manage =
    principal.type === "web" && (agent.ownerId === subject.userId || subject.role === "admin");
  if (!manage) {
    return {
      ok: false,
      res: apiError(403, "forbidden", "只有智能体所有者可以查看与操作回调投递"),
    };
  }
  return { ok: true, agent, principal };
}
