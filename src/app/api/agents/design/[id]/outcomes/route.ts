import { getContainer } from "@/lib/container";
import { designCaller, designError } from "../../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 记下某一轮设计器提议的处理结果(已应用到草稿 / 没有应用),存在设计会话的服务端状态里,
 * 构建页从 GET /api/agents/design/[id] 的 outcomes 读回。只能写自己的设计会话(designer 校验归属)。
 * 请求体:{ turnKey: 运行 ID, outcomes: [{ section, count, applied }] };返回全部处理记录。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { subject } = await designCaller(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "invalid request" }, { status: 400 });
    const outcomes = await getContainer().designer.recordOutcomes(subject, (await params).id, body);
    return Response.json({ outcomes });
  } catch (err) {
    return designError(err);
  }
}
