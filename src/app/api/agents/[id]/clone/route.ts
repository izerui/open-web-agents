import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { cloneAgentInTransaction } from "@/lib/modules/agent/application/clone-agent";
import { pickAgentConfig, redactAgentConfigForClone } from "@/lib/modules/agent/domain/config";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agents, auth, knowledge, releases, audit, db, knowledgeWriterFactory } = getContainer();
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

    const clonedConfig = redactAgentConfigForClone(published.config);
    const { escapeHatch: _, ...safeConfig } = clonedConfig;
    const picked = pickAgentConfig(safeConfig);

    const clonedName = body.name?.trim() || `${published.name}（副本）`;
    const clonedId = randomUUID().replace(/-/g, "").slice(0, 24);
    const includeKnowledge = body.includeKnowledge !== false;

    const fullDocs: { title: string; content: string }[] = [];
    if (includeKnowledge) {
      const listing = await knowledge.list(id);
      for (const item of listing.docs) {
        const doc = await knowledge.get(item.id);
        if (!doc) {
          return Response.json(
            { error: `知识库文档「${item.title}」读取失败，克隆中止` },
            { status: 500 },
          );
        }
        fullDocs.push({ title: doc.title, content: doc.content });
      }
    }

    const result = await cloneAgentInTransaction(
      db,
      {
        clonedId,
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
        docs: fullDocs,
      },
      knowledgeWriterFactory,
    );

    await audit.record({
      actor: principal,
      action: "agent.clone",
      resource: { type: "agent", id: clonedId },
      ownerId: subject.userId,
      details: {
        sourceAgentId: id,
        sourceVersion: source.publishedVersion,
        knowledgeCopied: result.knowledgeCopied,
      },
      req,
    });

    return Response.json(result, { status: 201 });
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    return Response.json({ error: "克隆失败" }, { status: 500 });
  }
}
