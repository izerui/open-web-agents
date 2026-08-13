import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";

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
  const subject = await auth.resolveSubject(req);
  const agent = await agents.get(agentId);
  if (!agent) return { error: Response.json({ error: "not found" }, { status: 404 }) };

  const list = await grants.listForResource("agent", agentId);
  // 连读都无权 → 404,不确认资源存在
  if (!hasResourceAccess(subject, agent, "read", list)) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (need === "write" && !hasResourceAccess(subject, agent, "write", list)) {
    return { error: Response.json({ error: "no write permission" }, { status: 403 }) };
  }
  return { agent };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { knowledge } = getContainer();
  try {
    // 列表只回标题与时间(不含正文),read 权限即可
    const r = await requirePermission(req, id, "read");
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
    const r = await requirePermission(req, id, "write");
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
      agentId: id,
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
    return Response.json({ deleted: docId });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
