import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { requirePermission } from "../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_CHARS = 2000;

/**
 * 检索测试:输入一个问题,按运行时同一份检索逻辑与缓存,看会命中哪些片段、实际注入给模型的文本。
 * 能看知识库列表的人(read)就能测;不调用模型,不消耗积分。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await requirePermission(req, id, "read");
    if (r.error) return r.error;
    const body = (await req.json().catch(() => ({}))) as { query?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return Response.json({ error: "请输入要测试的问题" }, { status: 400 });
    if (query.length > MAX_QUERY_CHARS) {
      return Response.json({ error: `问题不能超过 ${MAX_QUERY_CHARS} 字` }, { status: 400 });
    }
    const { hits, context } = await getContainer().searchKnowledge(id, query);
    return Response.json({
      hits: hits.map((h) => ({
        docId: h.docId,
        docTitle: h.docTitle,
        index: h.index,
        score: Math.round(h.score * 1000) / 1000,
        text: h.text,
      })),
      context,
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
