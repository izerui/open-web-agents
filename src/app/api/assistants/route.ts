import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type Subject,
  filterVisible,
  hasResourceAccess,
  isPublic,
} from "@/lib/modules/access/domain/grants";
import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";
import { validateAssistantConfig } from "@/lib/modules/assistant/domain/validate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出调用方可见的助手:自己的 + 被分享的 + 公开的(admin 看全部)。 */
export async function GET(req: Request) {
  const { assistants, grants, auth } = getContainer();
  try {
    const subject = await auth.resolveSubject(req);
    const all = await assistants.list();
    // 一次拉齐该类型的授权,避免逐个助手查一次(N+1)
    const allGrants = await grants.listForType("assistant");

    return Response.json({
      assistants: filterVisible(subject, all, allGrants).map((a) => ({
        ...a,
        isPublic: isPublic(a.id, allGrants),
        canWrite: hasResourceAccess(subject, a, "write", allGrants),
      })),
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
  config?: Partial<AssistantConfig>;
}

/**
 * 创建/更新助手(助手构建器的后端)。
 * 对外 API Key 一律拒绝 —— 否则调用方能改掉助手的提示词与输出契约。
 * 改已有助手需 write 权限:只被分享了 read 的人能用、不能改。
 */
export async function POST(req: Request) {
  const { assistants, grants, auth } = getContainer();

  let subject: Subject;
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAssistants(principal);
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
  const issues = validateAssistantConfig(body.config ?? {});
  if (issues.length) {
    return Response.json(
      { error: issues.map((i) => `${i.field}: ${i.message}`).join("; "), issues },
      { status: 400 },
    );
  }

  const targetId = body.id?.trim();
  let ownerId = subject.userId;

  if (targetId) {
    const existing = await assistants.get(targetId);
    if (existing) {
      const list = await grants.listForResource("assistant", targetId);
      // 连读都无权时返回 404 —— 用 403 会向调用方确认"这个 id 确实存在",是信息泄露
      if (!hasResourceAccess(subject, existing, "read", list)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (!hasResourceAccess(subject, existing, "write", list)) {
        return Response.json({ error: "no write permission on this assistant" }, { status: 403 });
      }
      // 改别人分享过来的助手时不改变归属
      ownerId = existing.ownerId;
    }
  }

  const cfg = body.config as Partial<AssistantConfig>;
  const saved = await assistants.upsert({
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
      outputSchema: cfg.outputSchema,
      verifyRules: cfg.verifyRules,
      escapeHatch: cfg.escapeHatch,
    },
  });

  return Response.json({ assistant: saved }, { status: 201 });
}
