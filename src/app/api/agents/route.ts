import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type Subject,
  filterVisible,
  hasResourceAccess,
  isPublic,
} from "@/lib/modules/access/domain/grants";
import {
  type AgentConfig,
  pickAgentConfig,
  redactAgentConfigForReader,
} from "@/lib/modules/agent/domain/config";
import { validateAgentConfig } from "@/lib/modules/agent/domain/validate-config";
import { validateWebhookUrl } from "@/lib/modules/integration/domain/webhook-policy";

/**
 * 能否查看和修改智能体的 webhook:只有所有者(与平台管理员)。
 *
 * 【为什么 write 权限不够】回调里带的是该智能体所有调用的结构化结果。
 * 被分享了 write 的协作者若能改 webhookUrl,就能把所有者名下全部 invoke 的结果
 * 转发到自己的服务器上 —— 改提示词至少还看得见,改回调地址是静默外泄。
 */
function canManageWebhook(subject: Subject, agent: { ownerId: string }): boolean {
  return agent.ownerId === subject.userId || subject.role === "admin";
}

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
      agents: filterVisible(subject, all, allGrants).map((a) => {
        const manage = canManageWebhook(subject, a);
        const canWrite = hasResourceAccess(subject, a, "write", allGrants);
        return {
          ...a,
          // 只读者(含公开智能体的所有用户)看不到 MCP 环境变量与逃生舱
          config: canWrite ? a.config : redactAgentConfigForReader(a.config),
          // 回调地址可能带着接收方的令牌,非所有者不该看到
          webhookUrl: manage ? a.webhookUrl : undefined,
          isPublic: isPublic(a.id, allGrants),
          canWrite,
          canManageWebhook: manage,
        };
      }),
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

  const cfg = pickAgentConfig((body.config ?? {}) as Partial<AgentConfig>);
  const targetId = body.id?.trim();
  let ownerId = subject.userId;
  let escapeHatch = cfg.escapeHatch;
  let existingHatch: Record<string, unknown> | undefined;
  const requestedWebhook = body.webhookUrl?.trim() || undefined;
  let webhookUrl = requestedWebhook;

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
      if (!canManageWebhook(subject, existing)) {
        // 协作者看不到回调地址,保存时自然不会带上 —— 沿用原值,而不是把它清掉
        if (requestedWebhook !== undefined && requestedWebhook !== existing.webhookUrl) {
          return Response.json(
            { error: "只有智能体所有者可以设置 webhook 回调地址" },
            { status: 403 },
          );
        }
        webhookUrl = existing.webhookUrl;
      }
      // 构建器不提交逃生舱:没带就沿用原值,否则任何一次保存都会把管理员设的逃生舱清掉
      existingHatch = existing.config.escapeHatch;
      if (cfg.escapeHatch === undefined) escapeHatch = existingHatch;
    }
  }

  // 逃生舱只给平台管理员:它能改动平台没建模的运行参数,不是普通作者该碰的东西。
  // 原样回传已有值不算修改(调用方可能 GET 后整份 POST 回来)
  if (
    cfg.escapeHatch !== undefined &&
    subject.role !== "admin" &&
    JSON.stringify(cfg.escapeHatch) !== JSON.stringify(existingHatch)
  ) {
    return Response.json({ error: "只有平台管理员可以设置逃生舱(escapeHatch)" }, { status: 403 });
  }

  // 只校验本次提交的新地址;沿用的存量地址在投递时还会按解析结果再查一次
  if (requestedWebhook && webhookUrl === requestedWebhook) {
    const v = validateWebhookUrl(requestedWebhook, { allowPrivate: env.webhookAllowPrivate });
    if (!v.ok) return Response.json({ error: v.reason }, { status: 400 });
  }

  const saved = await agents.upsert({
    id: targetId || randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId,
    name: body.name.trim(),
    icon: body.icon,
    description: body.description,
    webhookUrl,
    config: {
      ...cfg,
      systemPrompt: cfg.systemPrompt as string,
      model: cfg.model ?? "sonnet",
      maxTurns: cfg.maxTurns ?? 20,
      escapeHatch,
    },
  });

  return Response.json({ agent: saved }, { status: 201 });
}
