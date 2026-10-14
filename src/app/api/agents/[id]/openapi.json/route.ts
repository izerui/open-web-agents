import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { buildAgentOpenApi } from "@/lib/modules/integration/domain/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 该智能体的 OpenAPI 文档:入参与结果契约都嵌在里面,可直接导入 Postman 或生成客户端。
 * 有权调用这个智能体的人(登录用户或 API Key)才能取。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { auth, agents, releases } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertCanInvoke(principal, id);
    const agent = await agents.get(id);
    if (!agent) return apiError(404, "not_found", "agent not found");
    // 文档描述的是调用方默认会拿到的那一版(已发布;从未发布则为草稿)
    const release = await releases.resolve(agent);
    const origin = new URL(req.url).origin;
    return Response.json(
      buildAgentOpenApi(
        {
          id: agent.id,
          name: release.name,
          description: release.description,
          inputSchema: release.config.inputSchema,
          outputSchema: release.config.outputSchema,
          version: release.version,
        },
        origin,
      ),
    );
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
