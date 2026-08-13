import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type Subject,
  filterVisible,
  hasResourceAccess,
  isPublic,
} from "@/lib/modules/access/domain/grants";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import { validateAgentConfig } from "@/lib/modules/agent/domain/validate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出调用方可见的智能体:自己的 + 被分享的 + 公开的(admin 看全部)。 */
export async function GET(req: Request) {
  const { agents, grants, auth, env } = getContainer();
  try {
    const subject = await auth.resolveSubject(req);
    const all = await agents.list();
    // 一次拉齐该类型的授权,避免逐个智能体查一次(N+1)
    const allGrants = await grants.listForType("agent");

    return Response.json({
      agents: filterVisible(subject, all, allGrants).map((a) => ({
        ...a,
        isPublic: isPublic(a.id, allGrants),
        canWrite: hasResourceAccess(subject, a, "write", allGrants),
      })),
      capabilities: { stdioMcp: env.allowStdioMcp },
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface CreateBody {
  id?: string;
  name?: string;
  icon?: string;
  description?: string;
  /** 配了就在运行终态推一次结果回调。 */
  webhookUrl?: string;
  config?: Partial<AgentConfig>;
}

/**
 * 创建/更新智能体(智能体构建器的后端)。
 * 对外 API Key 一律拒绝 —— 否则调用方能改掉智能体的提示词与输出契约。
 * 改已有智能体需 write 权限:只被分享了 read 的人能用、不能改。
 */
export async function POST(req: Request) {
  const { agents, grants, auth, env } = getContainer();

  let subject: Subject;
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    subject = await auth.subjectOf(principal);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as CreateBody;
  if (!body.name?.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  // 配置错了要在保存时就拦住 —— 否则问题会推迟到运行时才暴露,排查成本高得多
  const issues = validateAgentConfig(body.config ?? {}, {
    allowStdioMcp: env.allowStdioMcp,
  });
  if (issues.length) {
    return Response.json(
      { error: issues.map((i) => `${i.field}: ${i.message}`).join("; "), issues },
      { status: 400 },
    );
  }

  const targetId = body.id?.trim();
  let ownerId = subject.userId;

  if (targetId) {
    const existing = await agents.get(targetId);
    if (existing) {
      const list = await grants.listForResource("agent", targetId);
      // 连读都无权时返回 404 —— 用 403 会向调用方确认"这个 id 确实存在",是信息泄露
      if (!hasResourceAccess(subject, existing, "read", list)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!hasResourceAccess(subject, existing, "write", list)) {
        return Response.json({ error: "no write permission on this agent" }, { status: 403 });
      }
      // 改别人分享过来的智能体时不改变归属
      ownerId = existing.ownerId;
    }
  }

  const cfg = body.config as Partial<AgentConfig>;
  const saved = await agents.upsert({
    id: targetId || randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId,
    name: body.name.trim(),
    icon: body.icon,
    description: body.description,
    webhookUrl: body.webhookUrl,
    config: {
      systemPrompt: cfg.systemPrompt as string,
      model: cfg.model ?? "sonnet",
      maxTurns: cfg.maxTurns ?? 20,
      effort: cfg.effort,
      skills: cfg.skills,
      mcpServers: cfg.mcpServers,
      tools: cfg.tools,
      subagents: cfg.subagents,
      // 【显式白名单的代价】这里逐字段列举而非 spread —— 好处是外部塞不进意料之外的键,
      // 坏处是新增字段忘了加就【静默丢弃】:保存返回 201、界面显示成功,
      // 读回来才发现字段没了,全程没有任何报错。inputSchema 就这么漏过一次。
      inputSchema: cfg.inputSchema,
      outputSchema: cfg.outputSchema,
      verifyRules: cfg.verifyRules,
      approvalRules: cfg.approvalRules,
      escapeHatch: cfg.escapeHatch,
    },
  });

  return Response.json({ agent: saved }, { status: 201 });
}
