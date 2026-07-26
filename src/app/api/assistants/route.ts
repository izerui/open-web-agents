import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import type { AssistantConfig } from "@/lib/modules/assistant/domain/config";

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
  config?: Partial<AssistantConfig>;
}

/** 创建/更新助手(助手构建器的后端)。 */
export async function POST(req: Request) {
  const { assistants } = getContainer();
  const body = (await req.json().catch(() => ({}))) as CreateBody;

  if (!body.name?.trim()) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (!body.config?.systemPrompt?.trim()) {
    return Response.json({ error: "config.systemPrompt is required" }, { status: 400 });
  }

  const saved = await assistants.upsert({
    id: body.id ?? randomUUID().replace(/-/g, "").slice(0, 24),
    name: body.name.trim(),
    icon: body.icon,
    description: body.description,
    config: {
      systemPrompt: body.config.systemPrompt,
      model: body.config.model ?? "sonnet",
      maxTurns: body.config.maxTurns ?? 20,
      effort: body.config.effort,
      skills: body.config.skills,
      mcpServers: body.config.mcpServers,
      tools: body.config.tools,
      subagents: body.config.subagents,
      outputSchema: body.config.outputSchema,
      verifyRules: body.config.verifyRules,
      escapeHatch: body.config.escapeHatch,
    },
  });

  return Response.json({ assistant: saved }, { status: 201 });
}
