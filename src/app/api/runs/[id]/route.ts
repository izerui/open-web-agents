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
    // 会话是私有的:管理员能看全平台运行的记录,但打不开别人的会话(界面据此禁用「在对话里查看」)
    const canOpenSession =
      !!run &&
      canAccessSession(principal, { id: run.sessionId, agentId: run.agentId, ...run.ownership })
        .allowed;
    const allowed = canOpenSession || (principal.type === "web" && principal.role === "admin");
    if (!run || !allowed) return apiError(404, "not_found", "run not found");
    const { ownership: _o, account, ...visible } = run;
    // 计费账号只给管理员(平台运行要看得出是谁的运行);普通用户看的是自己的运行,不需要
    const isAdmin = principal.type === "web" && principal.role === "admin";
    return Response.json({
      run: { ...visible, ...(isAdmin && account ? { account } : {}), canOpenSession },
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
