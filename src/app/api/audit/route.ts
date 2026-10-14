import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { isAuditAction } from "@/lib/modules/audit/domain/events";
import type { AuditFilter } from "@/lib/modules/audit/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 时间参数:ISO 字符串或毫秒数。 */
function parseTime(v: string | null): number | undefined | null {
  if (v === null || v === "") return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 审计日志查询。只限网页登录(API Key 是调用凭证,不该能翻审计)。
 * 普通用户看"与自己有关"的:自己是资源归属人或操作者;管理员加 scope=all 看全部。
 */
export async function GET(req: Request) {
  const { auth, audit } = getContainer();
  let userId: string;
  let isAdmin: boolean;
  try {
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    const subject = await auth.subjectOf(principal);
    userId = subject.userId;
    isAdmin = subject.role === "admin";
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const q = new URL(req.url).searchParams;
  const action = q.get("action") || undefined;
  if (action !== undefined && !isAuditAction(action)) {
    return apiError(400, "invalid_request", `未知的 action:${action}`);
  }
  const since = parseTime(q.get("since"));
  const until = parseTime(q.get("until"));
  if (since === null || until === null) {
    return apiError(400, "invalid_request", "since / until 须为 ISO 时间或毫秒数");
  }
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return apiError(400, "invalid_request", "limit 须为 1~200 的整数");
  }
  const scopeAll = q.get("scope") === "all";
  if (scopeAll && !isAdmin) return apiError(403, "forbidden", "只有管理员能查看全部审计日志");

  const filter: AuditFilter = {
    visibleTo: scopeAll ? undefined : userId,
    action,
    resourceType: q.get("resourceType") || undefined,
    resourceId: q.get("resourceId") || undefined,
    since,
    until,
    cursor: q.get("cursor") || undefined,
    limit,
  };
  return Response.json(await audit.list(filter));
}
