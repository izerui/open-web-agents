import { apiError } from "@/lib/api-error";
import { type Container, getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { ModelAdminError } from "@/lib/modules/model-gateway/application/model-admin";

export interface AdminContext {
  c: Container;
  principal: Principal;
  actorId: string;
}

/** 平台管理员才能维护模型提供者;领域错误映射成 400/404/409,其余照常抛出。 */
export async function asModelAdmin(
  req: Request,
  fn: (ctx: AdminContext) => Promise<Response>,
): Promise<Response> {
  const c = getContainer();
  let ctx: AdminContext;
  try {
    const principal = await c.auth.resolveWeb(req);
    c.auth.assertCanAdministerPlatform(principal);
    const subject = await c.auth.subjectOf(principal);
    ctx = { c, principal, actorId: subject.userId };
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof ModelAdminError) return apiError(err.status, err.code, err.message);
    throw err;
  }
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ModelAdminError(400, "invalid_request", "请求体须为 JSON 对象");
  }
  return body as Record<string, unknown>;
}
