import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { ARCHITECT_AGENT_ID } from "@/lib/modules/agent/domain/architect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 平台内置的智能体:每次启动都会重新播种,删了也会回来;而且所有用户都在用。 */
const BUILT_IN = new Set(["default", ARCHITECT_AGENT_ID]);

/**
 * 删除智能体(软删除)。
 *
 * 之后列表、调用、分享、继续对话都当它不存在;绑定它的 Key 随之失效
 * (授权判定读不到它)。历史会话、运行记录、审计、版本保留,运行记录照常显示名称。
 * 只有所有者与平台管理员能删 —— 被分享 write 的协作者能改它,但不能删掉别人的智能体。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const { agent, subject, principal } = opened;
  if (agent.ownerId !== subject.userId && subject.role !== "admin") {
    return apiError(403, "forbidden", "只有智能体所有者可以删除它");
  }
  if (BUILT_IN.has(id)) return apiError(409, "invalid_request", "平台内置的智能体不能删除");

  const { agents, audit } = getContainer();
  if (!(await agents.softDelete(id, Date.now()))) {
    return apiError(404, "not_found", "agent not found");
  }
  await audit.record({
    actor: principal,
    action: "agent.delete",
    resource: { type: "agent", id },
    ownerId: agent.ownerId,
    details: { name: agent.name },
    req,
  });
  return Response.json({ deleted: id });
}
