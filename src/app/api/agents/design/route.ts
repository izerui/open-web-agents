import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";
import { agentToBundle } from "@/lib/modules/agent/domain/agent-bundle";
import { ARCHITECT_AGENT_ID, emptyBundle } from "@/lib/modules/agent/domain/architect";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 开一个"AI 智能体设计师"会话。
 *
 * - 不带 agentId:从零设计一个新智能体
 * - 带 agentId:修改已有的智能体 —— 先把它当前的定义导出到工作目录,设计师在此基础上改
 *
 * 设计师只编辑工作目录里的文件;写回平台要用户在工作台里点"应用"(见 ./apply)。
 */
export async function POST(req: Request) {
  const { auth, agents, grants, sessions, env, bundles } = getContainer();
  let userId: string;
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    const subject = await auth.subjectOf(principal);
    userId = subject.userId;

    const body = (await req.json().catch(() => ({}))) as { agentId?: string };
    let files = emptyBundle();
    let title = "设计:新智能体";
    if (body.agentId) {
      const target = await agents.get(body.agentId);
      const list = target ? await grants.listForResource("agent", body.agentId) : [];
      // 与保存接口同一口径:不存在与无权同回 404,不做存在性预言机
      if (!target || !hasResourceAccess(subject, target, "read", list)) {
        return apiError(404, "not_found", "agent not found");
      }
      if (!hasResourceAccess(subject, target, "write", list)) {
        return apiError(403, "forbidden", "没有修改这个智能体的权限");
      }
      files = agentToBundle({
        name: target.name,
        description: target.description,
        config: target.config,
      });
      title = `设计:${target.name}`;
    }

    const sessionId = randomUUID().replace(/-/g, "").slice(0, 24);
    const workspaceDir = workspacePathFor(env.dataDir, sessionId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await bundles.write(workspaceDir, files);
    await sessions.create({
      id: sessionId,
      agentId: ARCHITECT_AGENT_ID,
      workspaceDir,
      title,
      ownerId: userId,
      billingUserId: userId,
      source: "web",
      designTargetAgentId: body.agentId,
    });
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
