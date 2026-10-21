import { getContainer } from "@/lib/container";

/** 每个账号每分钟最多测几次:测试连接是平台替用户去连外部地址,不能被当成扫描器用 */
const PER_MINUTE = 20;

/** 超出返回 429 响应,否则 null */
export async function mcpCheckRateLimited(userId: string): Promise<Response | null> {
  const v = await getContainer().rateLimiter.hit(`mcp-check:acct:${userId}`, PER_MINUTE, 60_000);
  if (v.allowed) return null;
  return Response.json(
    { error: "测试连接太频繁,请稍后再试", code: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(v.retryAfterMs / 1000)) } },
  );
}
