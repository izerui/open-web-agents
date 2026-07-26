import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 知识库内容会进提示词、影响回答,所以改动它需要 write 权限(与改提示词同级)。 */
async function requireWrite(req: Request, assistantId: string) {
  const { assistants, grants, auth } = getContainer();
  const subject = await auth.resolveSubject(req);
  const assistant = await assistants.get(assistantId);
  if (!assistant) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const list = await grants.listForResource("assistant", assistantId);
  // 连读都无权 → 404,不确认资源存在
  if (!hasResourceAccess(subject, assistant, "read", list)) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (!hasResourceAccess(subject, assistant, "write", list)) {
    return { error: Response.json({ error: "no write permission" }, { status: 403 }) };
  }
  return { assistant };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    const r = await requireWrite(req, id);
    if (r.error) return r.error;
    return Response.json({ docs: await knowledge.list(id) });
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
    const r = await requireWrite(req, id);
    if (r.error) return r.error;

    const body = (await req.json().catch(() => ({}))) as { title?: string; content?: string };
    const title = body.title?.trim();
    const content = body.content?.trim();
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    if (!content) return Response.json({ error: "content is required" }, { status: 400 });
    // 单篇上限:再大就该拆分或换带持久索引的实现,而不是硬塞
    if (content.length > 200_000) {
      return Response.json({ error: "单篇文档过长(上限 20 万字),请拆分" }, { status: 400 });
    }

    const doc = await knowledge.create({
      id: randomUUID().replace(/-/g, "").slice(0, 24),
      assistantId: id,
      title,
      content,
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
    const r = await requireWrite(req, id);
    if (r.error) return r.error;

    const docId = new URL(req.url).searchParams.get("docId");
    if (!docId) return Response.json({ error: "docId is required" }, { status: 400 });

    // 只能删本助手的文档,防止拿别助手的 docId 越权删除
    const doc = await knowledge.get(docId);
    if (!doc || doc.assistantId !== id) {
      return Response.json({ error: "该文档不属于本助手" }, { status: 404 });
    }
    await knowledge.delete(docId);
    return Response.json({ deleted: docId });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
