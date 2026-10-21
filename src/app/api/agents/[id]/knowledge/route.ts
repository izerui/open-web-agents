import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { KnowledgeLimitExceeded } from "@/lib/modules/knowledge/domain/limits";
import { requirePermission } from "./_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if ([...title].length > 255)
      return Response.json({ error: "标题不能超过 255 字" }, { status: 400 });
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

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    const r = await requirePermission(req, id, "write");
    if (r.error) return r.error;

    const body = (await req.json().catch(() => null)) as {
      docId?: string;
      title?: string;
      content?: string;
    } | null;
    if (!body?.docId) return Response.json({ error: "docId is required" }, { status: 400 });
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
      return Response.json({ error: "title 不能为空" }, { status: 400 });
    }
    if (body.title !== undefined && [...body.title.trim()].length > 255) {
      return Response.json({ error: "标题不能超过 255 字" }, { status: 400 });
    }
    if (body.content !== undefined && (typeof body.content !== "string" || !body.content.trim())) {
      return Response.json({ error: "content 不能为空" }, { status: 400 });
    }

    const doc = await knowledge.get(body.docId);
    if (!doc || doc.agentId !== id) {
      return Response.json({ error: "该文档不属于本智能体" }, { status: 404 });
    }

    const updated = await knowledge.update(body.docId, {
      title: body.title?.trim(),
      content: body.content,
    });
    if (!updated) return Response.json({ error: "更新失败" }, { status: 500 });

    await getContainer().audit.record({
      actor: r.principal,
      action: "knowledge.update",
      resource: { type: "agent", id },
      ownerId: r.agent.ownerId,
      details: { docId: body.docId, title: updated.title },
      req,
    });

    return Response.json({
      doc: { id: updated.id, title: updated.title, chars: [...updated.content].length },
    });
  } catch (err) {
    if (err instanceof KnowledgeLimitExceeded) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
