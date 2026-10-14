import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canAccessSession } from "@/lib/modules/access/domain/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 一次运行的完整记录:输入、最终文本、结构化结果、错误、花费、耗时。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { auth, runQuery } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const run = await runQuery.detail(id);
    // 不存在与无权同回 404:运行 id 不该能被探测
    const allowed =
      run &&
      (canAccessSession(principal, { id: run.sessionId, agentId: run.agentId, ...run.ownership })
        .allowed ||
        (principal.type === "web" && principal.role === "admin"));
    if (!run || !allowed) return apiError(404, "not_found", "run not found");
    const { ownership: _o, ...visible } = run;
    return Response.json({ run: visible });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
