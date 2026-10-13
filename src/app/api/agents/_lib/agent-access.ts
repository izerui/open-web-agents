import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { type Subject, hasResourceAccess } from "@/lib/modules/access/domain/grants";
import type { Agent } from "@/lib/modules/agent/ports";

export type AgentAccess =
  | { ok: true; agent: Agent; subject: Subject; canWrite: boolean }
  | { ok: false; res: Response };

/**
 * 打开一个智能体并校验权限。
 *
 * - read:登录用户或 API Key,能看到这个智能体即可;
 * - write:只限网页登录且有管理智能体的功能权限,并对该智能体有 write 授权
 *   (发布、回滚会改变所有对外调用方拿到的结果,不该交给 API Key)。
 *
 * 连读都无权时一律 404 —— 用 403 等于向调用方确认"这个 id 确实存在"。
 */
export async function openAgent(
  req: Request,
  id: string,
  level: "read" | "write",
): Promise<AgentAccess> {
  const { auth, agents, grants } = getContainer();
  let subject: Subject;
  try {
    const principal = await auth.resolveWeb(req);
    if (level === "write") auth.assertCanManageAgents(principal);
    subject = await auth.subjectOf(principal);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return { ok: false, res };
    throw err;
  }

  const agent = await agents.get(id);
  const list = agent ? await grants.listForResource("agent", id) : [];
  if (!agent || !hasResourceAccess(subject, agent, "read", list)) {
    return { ok: false, res: apiError(404, "not_found", "agent not found") };
  }
  const canWrite = hasResourceAccess(subject, agent, "write", list);
  if (level === "write" && !canWrite) {
    return { ok: false, res: apiError(403, "forbidden", "no write permission on this agent") };
  }
  return { ok: true, agent, subject, canWrite };
}
