import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Subject } from "@/lib/modules/access/domain/grants";
import { type Principal, agentAccessLevel } from "@/lib/modules/access/domain/principal";
import type { Agent } from "@/lib/modules/agent/ports";

export type AgentAccess =
  | { ok: true; agent: Agent; principal: Principal; subject: Subject; canWrite: boolean }
  | { ok: false; res: Response };

/**
 * 打开一个智能体并校验权限(判定见 agentAccessLevel)。
 *
 * - read:登录用户,或【绑定在这个智能体上 / 未绑定】的 API Key;
 * - write:只限网页登录、有管理智能体的功能权限,且对该智能体有 write 授权。
 *   API Key 永远不是 write —— 签发人的写权限不传给 Key,所以 Key 也拿不到未脱敏配置。
 *
 * 连读都无权时一律 404 —— 用 403 等于向调用方确认"这个 id 确实存在"。
 */
export async function openAgent(
  req: Request,
  id: string,
  level: "read" | "write",
): Promise<AgentAccess> {
  const { auth, agents, grants } = getContainer();
  let principal: Principal;
  let subject: Subject;
  try {
    principal = await auth.resolveWeb(req);
    if (level === "write") auth.assertCanManageAgents(principal);
    subject = await auth.subjectOf(principal);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return { ok: false, res };
    throw err;
  }

  const agent = await agents.get(id);
  const access = agent
    ? agentAccessLevel(principal, agent, subject, await grants.listForResource("agent", id))
    : "none";
  if (!agent || access === "none") {
    return { ok: false, res: apiError(404, "not_found", "agent not found") };
  }
  if (level === "write" && access !== "write") {
    return { ok: false, res: apiError(403, "forbidden", "no write permission on this agent") };
  }
  return { ok: true, agent, principal, subject, canWrite: access === "write" };
}
