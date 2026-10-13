import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";
import { bundleToAgent } from "@/lib/modules/agent/domain/agent-bundle";
import { ARCHITECT_AGENT_ID } from "@/lib/modules/agent/domain/architect";
import { validateAgentConfig } from "@/lib/modules/agent/domain/validate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 把设计会话工作目录里的智能体包应用到平台:解析 → 按正式规则校验 → 创建或更新。
 *
 * 【为什么要人点这一下】设计师是个 agent,它的工作目录里的内容可能受对话里混进来的
 * 指令影响。写回平台必须由有权限的人确认,并且走与构建器保存完全相同的校验。
 * webhook、逃生舱、归属这些字段不在智能体包里,应用时一律沿用原值。
 */
export async function POST(req: Request) {
  const { auth, agents, grants, sessions, env, bundles } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    const subject = await auth.subjectOf(principal);

    const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
    if (!body.sessionId) return apiError(400, "invalid_request", "sessionId is required");
    await auth.assertSessionAccess(principal, body.sessionId);
    const session = await sessions.get(body.sessionId);
    if (!session || session.agentId !== ARCHITECT_AGENT_ID) {
      return apiError(400, "invalid_request", "这不是一个智能体设计会话");
    }

    let files: Record<string, string>;
    try {
      files = await bundles.read(session.workspaceDir);
    } catch (e) {
      return apiError(400, "invalid_request", (e as Error).message);
    }
    const parsed = bundleToAgent(files);
    if (!parsed.ok) {
      return apiError(400, "invalid_request", "智能体包有问题", { issues: parsed.issues });
    }
    const issues = validateAgentConfig(parsed.agent.config, { allowStdioMcp: env.allowStdioMcp });
    if (issues.length) {
      return apiError(400, "invalid_request", "配置校验未通过", { issues });
    }

    const targetId = session.designTargetAgentId;
    const existing = targetId ? await agents.get(targetId) : null;
    if (existing) {
      const list = await grants.listForResource("agent", existing.id);
      if (!hasResourceAccess(subject, existing, "write", list)) {
        return apiError(403, "forbidden", "没有修改这个智能体的权限");
      }
    }

    const saved = await agents.upsert({
      id: existing?.id ?? randomUUID().replace(/-/g, "").slice(0, 24),
      ownerId: existing?.ownerId ?? subject.userId,
      name: parsed.agent.name,
      description: parsed.agent.description,
      // 包里没有的字段沿用原值:回调地址、逃生舱只由所有者在构建器里设置
      webhookUrl: existing?.webhookUrl,
      config: { ...parsed.agent.config, escapeHatch: existing?.config.escapeHatch },
    });
    if (!existing) await sessions.update(session.id, { designTargetAgentId: saved.id });

    return Response.json({
      agent: { id: saved.id, name: saved.name },
      created: !existing,
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
