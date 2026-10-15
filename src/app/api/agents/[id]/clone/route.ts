import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { pickAgentConfig, redactAgentConfigForReader } from "@/lib/modules/agent/domain/config";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";
import { validateAgentConfig } from "@/lib/modules/agent/domain/validate-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agents, auth, knowledge, releases, audit, env } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    const subject = await auth.subjectOf(principal);
    const { id } = await params;

    if (isSystemAgent(id)) {
      return Response.json({ error: "agent not found" }, { status: 404 });
    }

    const source = await agents.get(id);
    if (!source || !source.marketListed || source.publishedVersion == null) {
      return Response.json({ error: "只能克隆已上架到市场的智能体" }, { status: 403 });
    }

    const published = await releases.get(id, source.publishedVersion);
    if (!published) {
      return Response.json({ error: "已发布版本不可用" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      includeKnowledge?: boolean;
    };

    const clonedConfig = redactAgentConfigForReader(published.config);
    const { escapeHatch: _, ...safeConfig } = clonedConfig;
    const picked = pickAgentConfig(safeConfig);

    const issues = validateAgentConfig(picked, { allowStdioMcp: env.allowStdioMcp });
    if (issues.length) {
      return Response.json({ error: "源智能体配置校验未通过", issues }, { status: 422 });
    }

    const clonedName = body.name?.trim() || `${published.name}（副本）`;
    const clonedId = randomUUID().replace(/-/g, "").slice(0, 24);

    const saved = await agents.upsert({
      id: clonedId,
      ownerId: subject.userId,
      name: clonedName,
      icon: published.icon,
      description: published.description,
      config: {
        ...picked,
        systemPrompt: picked.systemPrompt ?? "",
        model: picked.model ?? "sonnet",
        maxTurns: picked.maxTurns ?? 20,
      },
    });

    const includeKnowledge = body.includeKnowledge !== false;
    let knowledgeCopied = 0;
    if (includeKnowledge) {
      const listing = await knowledge.list(id);
      for (const item of listing.docs) {
        const doc = await knowledge.get(item.id);
        if (!doc) continue;
        try {
          await knowledge.create({
            id: randomUUID().replace(/-/g, "").slice(0, 24),
            agentId: clonedId,
            title: doc.title,
            content: doc.content,
          });
          knowledgeCopied++;
        } catch {
          break;
        }
      }
    }

    await audit.record({
      actor: principal,
      action: "agent.clone",
      resource: { type: "agent", id: clonedId },
      ownerId: subject.userId,
      details: {
        sourceAgentId: id,
        sourceVersion: source.publishedVersion,
        knowledgeCopied,
      },
      req,
    });

    return Response.json({ agent: saved, knowledgeCopied }, { status: 201 });
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    throw err;
  }
}
