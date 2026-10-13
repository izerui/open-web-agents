import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { extractEmbedToken, verifyEmbedToken } from "@/lib/modules/integration/domain/embed-token";
import { PromptTooLarge, assertPromptSize } from "@/lib/modules/run/application/enqueue";
import { assertWithinQuota, quotaErrorResponse } from "@/lib/modules/usage/application/quota-guard";
import { streamRun } from "../../_lib/run-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * widget 发起一轮运行。
 *
 * 只认嵌入令牌,且【只能操作令牌绑定的那个会话】—— 会话 id 来自令牌本身而非请求体,
 * 所以拿到令牌也换不到别人的会话。
 */
export async function POST(req: Request) {
  const { runs, bus, sessions, users, usage, enqueuer, embedSecret, auth } = getContainer();

  const token = extractEmbedToken(req.headers);
  const claims = token ? verifyEmbedToken(embedSecret, token) : null;
  if (!claims) {
    return Response.json({ error: "invalid or expired embed token" }, { status: 401 });
  }
  // 令牌签名有效还不够:签发它的 key 被吊销、签发人被停用、分享被撤销,都必须立即失效
  try {
    await auth.resolveEmbed(claims);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  try {
    assertPromptSize(prompt);
  } catch (err) {
    if (err instanceof PromptTooLarge) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }

  const sessionId = claims.sessionId;
  const session = await sessions.get(sessionId);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  /*
   * 额度关卡。embed 曾经完全没有 —— 浏览器里的访客可以在令牌有效期内无限发起运行,
   * 花费记在签发 key 的账号上却不受它的额度约束。
   */
  if (session.billingUserId) {
    try {
      await assertWithinQuota({ users, usage }, session.billingUserId);
    } catch (err) {
      const quota = quotaErrorResponse(err);
      if (quota) return quota;
      throw err;
    }
  }

  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  return streamRun(req, {
    bus,
    results: runs,
    sessionId,
    runId,
    enqueue: () => enqueuer.enqueue({ runId, sessionId, prompt }),
  });
}
