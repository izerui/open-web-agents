import { getContainer } from "@/lib/container";
import { agentAccessLevel } from "@/lib/modules/access/domain/principal";

/**
 * 按操作分级鉴权。
 *
 * 口径要与智能体本身一致:被分享 read 的人能从智能体列表看到完整 systemPrompt,
 * 那么"这个智能体挂了哪几篇资料"(仅标题)同样属于 read 范畴 —— 两条路径不该一个
 * 能看一个 403。而增删知识文档会改变回答内容,与改提示词同级,必须 write。
 */
export async function requirePermission(req: Request, agentId: string, need: "read" | "write") {
  const { agents, grants, auth } = getContainer();
  // 保留 principal:API Key 的智能体绑定与"Key 不可写"都要算进去(见 agentAccessLevel)
  const principal = await auth.resolveWeb(req);
  const subject = await auth.subjectOf(principal);
  const agent = await agents.get(agentId);
  if (!agent) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const access = agentAccessLevel(
    principal,
    agent,
    subject,
    await grants.listForResource("agent", agentId),
  );
  // 连读都无权 → 404,不确认资源存在
  if (access === "none") {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (need === "write" && access !== "write") {
    return { error: Response.json({ error: "no write permission" }, { status: 403 }) };
  }
  return { agent, principal };
}
