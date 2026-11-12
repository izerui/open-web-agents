import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { Forbidden, authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { acceptInvoke } from "../../_lib/invoke-core";
import { runResultResponse } from "../../_lib/run-result-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 在线试调只给网页登录的人:API Key 请走对外的 invoke / result。 */
async function webPrincipal(req: Request): Promise<Principal & { type: "web" }> {
  const { auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  if (principal.type !== "web") throw new Forbidden("在线试调只支持网页登录,API Key 请调用 invoke");
  return principal;
}

/**
 * 构建页「在线试调」:在页面上按对外接口的契约跑一次(校验 inputSchema、按版本解析、计费)。
 *
 * 请求体 `{ input, version? }`(与 invoke 同一套字段,共用受理核心 _lib/invoke-core.ts);
 * 响应 202 `{ taskId, sessionId, structured, agentVersion }`,错误码与 invoke 一致。
 * 与 invoke 的不同:网页登录鉴权;会话记为接口调用(source=invoke),归属与计费都是本人,
 * 限流按 `user:<userId>`;不支持 Idempotency-Key 与 callbackUrl(传了 400),不投递 webhook。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params;
  const { auth } = getContainer();
  let principal: Principal;
  try {
    principal = await webPrincipal(req);
    await auth.assertCanInvoke(principal, agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  return acceptInvoke(req, agentId, principal, "try");
}

/**
 * 取试调结果:`?runId=<taskId>`。与 GET /api/agents/{taskId}/result 同一份结果契约
 * (toRunResult + 文件清单),但网页登录鉴权;运行必须属于路径里的智能体、
 * 会话本人可访问,否则一律 404(不区分「不存在」与「无权」,免得被拿来探测 id)。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params;
  const { auth, runs, sessions } = getContainer();
  const runId = new URL(req.url).searchParams.get("runId");

  let principal: Principal;
  try {
    principal = await webPrincipal(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!runId) return apiError(400, "invalid_request", "缺少 runId");

  const run = await runs.get(runId);
  if (!run) return apiError(404, "not_found", "task not found");
  const session = await sessions.get(run.sessionId);
  if (!session || session.agentId !== agentId) return apiError(404, "not_found", "task not found");
  try {
    await auth.assertSessionAccess(principal, run.sessionId);
  } catch (err) {
    if (err instanceof Forbidden) return apiError(404, "not_found", "task not found");
    throw err;
  }
  return runResultResponse(runId, run.sessionId);
}
