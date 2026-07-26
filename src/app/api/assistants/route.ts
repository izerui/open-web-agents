import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";
import { validateAssistantConfig } from "@/lib/modules/assistant/domain/validate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出助手。 */
export async function GET() {
  const { assistants } = getContainer();
  return Response.json({ assistants: await assistants.list() });
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
 */
export async function POST(req: Request) {
  const { assistants, auth } = getContainer();

  try {
    auth.assertCanManageAssistants(await auth.resolveWeb(req));
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

  const cfg = body.config as Partial<AssistantConfig>;
  const saved = await assistants.upsert({
    id: body.id ?? randomUUID().replace(/-/g, "").slice(0, 24),
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
