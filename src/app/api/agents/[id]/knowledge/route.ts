import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { agentAccessLevel } from "@/lib/modules/access/domain/principal";
import { KnowledgeLimitExceeded } from "@/lib/modules/knowledge/domain/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 按操作分级鉴权。
 *
 * 口径要与智能体本身一致:被分享 read 的人能从智能体列表看到完整 systemPrompt,
 * 那么"这个智能体挂了哪几篇资料"(仅标题)同样属于 read 范畴 —— 两条路径不该一个
 * 能看一个 403。而增删知识文档会改变回答内容,与改提示词同级,必须 write。
 */
async function requirePermission(req: Request, agentId: string, need: "read" | "write") {
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

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    // 列表只回标题、时间、字数与是否参与检索(不含正文),read 权限即可
    const r = await requirePermission(req, id, "read");
    if (r.error) return r.error;
    return Response.json(await knowledge.list(id));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 加一篇知识文档。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    const r = await requirePermission(req, id, "write");
    if (r.error) return r.error;

    const body = (await req.json().catch(() => ({}))) as { title?: string; content?: string };
    const title = body.title?.trim();
    const content = body.content?.trim();
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    if (!content) return Response.json({ error: "content is required" }, { status: 400 });
    // 单篇、篇数、总字数的上限在仓储里与插入同一事务判定(见 knowledge/domain/limits.ts)
    let doc: Awaited<ReturnType<typeof knowledge.create>>;
    try {
      doc = await knowledge.create({
        id: randomUUID().replace(/-/g, "").slice(0, 24),
        agentId: id,
        title,
        content,
      });
    } catch (err) {
      if (err instanceof KnowledgeLimitExceeded) {
        return apiError(409, "limit_exceeded", err.message);
      }
      throw err;
    }
    await getContainer().audit.record({
      actor: r.principal,
      action: "knowledge.add",
      resource: { type: "agent", id },
      ownerId: r.agent.ownerId,
      details: { docId: doc.id, title: doc.title, chars: content.length },
      req,
    });
    return Response.json({ doc: { id: doc.id, title: doc.title } }, { status: 201 });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    const r = await requirePermission(req, id, "write");
    if (r.error) return r.error;

    const docId = new URL(req.url).searchParams.get("docId");
    if (!docId) return Response.json({ error: "docId is required" }, { status: 400 });

    // 只能删本智能体的文档,防止拿别智能体的 docId 越权删除
    const doc = await knowledge.get(docId);
    if (!doc || doc.agentId !== id) {
      return Response.json({ error: "该文档不属于本智能体" }, { status: 404 });
    }
    await knowledge.delete(docId);
    await getContainer().audit.record({
      actor: r.principal,
      action: "knowledge.delete",
      resource: { type: "agent", id },
      ownerId: r.agent.ownerId,
      details: { docId, title: doc.title },
      req,
    });
    return Response.json({ deleted: docId });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
