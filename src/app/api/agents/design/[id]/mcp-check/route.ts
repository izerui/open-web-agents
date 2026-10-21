import { getContainer } from "@/lib/container";
import { mcpCheckRateLimited } from "../../../_lib/mcp-check-limit";
import { designCaller, designError } from "../../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * AI 编辑里的"测试连接":按名称测草稿里的某个 MCP。配置由服务端还原(预览里是脱敏的),
 * 与保存后实际运行的一致;变量值取本人在目标智能体上保存的。握手并列出工具,不调用工具
 */
export async function POST(req: Request, { params }: Context) {
  try {
    const { subject } = await designCaller(req);
    const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string" || !body.name) {
      return Response.json({ error: "name 必须是 MCP 名称" }, { status: 400 });
    }
    const { designer, mcpCheck } = getContainer();
    const found = await designer.mcpForCheck(subject, (await params).id, body.name);
    const limited = await mcpCheckRateLimited(subject.userId);
    if (limited) return limited;
    const result = await mcpCheck.check({
      def: found.def,
      variables: found.variables,
      agentId: found.targetId,
      userId: subject.userId,
    });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return designError(err);
  }
}
