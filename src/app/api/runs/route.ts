import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { RunQueryFilter } from "@/lib/modules/run/adapters/mysql-run-query";
import type { SessionSource } from "@/lib/modules/session/ports";
import type { RunState } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATES: RunState[] = ["pending", "running", "success", "failed", "cancelled"];
const SOURCES: SessionSource[] = ["web", "api", "invoke", "eval", "design"];

/** 逗号分隔的枚举值;含未知值返回 null。 */
function parseList<T extends string>(raw: string | null, allowed: T[]): T[] | undefined | null {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return items.every((x) => (allowed as string[]).includes(x)) ? (items as T[]) : null;
}

/** ISO 时间或毫秒时间戳。 */
function parseTime(raw: string | null): number | undefined | null {
  if (!raw) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 运行记录。曾经集成方没有任何办法列出、筛选自己的调用 ——
 * 只能记住每个 taskId 逐个去查,网页用户也看不到用自己 Key 发起的调用。
 *
 * - 登录用户:计费在自己名下的全部运行(工作台对话 + 自己的 Key 发起的调用)
 * - API Key:这把 key 发起的运行
 * - 管理员:scope=all 看全平台
 *
 * 查询参数:agentId、status(逗号分隔)、source(web/api/invoke)、since、until、cursor、limit(≤100)
 */
export async function GET(req: Request) {
  const { auth, runQuery } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    const q = new URL(req.url).searchParams;

    const statuses = parseList(q.get("status"), STATES);
    const sources = parseList(q.get("source"), SOURCES);
    const since = parseTime(q.get("since"));
    const until = parseTime(q.get("until"));
    if (statuses === null || sources === null || since === null || until === null) {
      return apiError(400, "invalid_request", "status / source / since / until 参数不合法");
    }
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), 100);

    const filter: RunQueryFilter = {
      agentId: q.get("agentId") ?? undefined,
      statuses,
      sources,
      since,
      until,
      cursor: q.get("cursor") ?? undefined,
      limit,
    };
    if (principal.type === "apiKey") filter.callerApiKeyId = principal.keyId;
    else if (!(q.get("scope") === "all" && principal.role === "admin")) {
      filter.billingUserId = principal.userId;
    }

    return Response.json(await runQuery.list(filter));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
