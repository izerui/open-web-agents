import { randomUUID } from "node:crypto";
import { admissionErrorResponse, callerOf } from "@/app/api/_lib/admission";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { extractEmbedToken, verifyEmbedToken } from "@/lib/modules/integration/domain/embed-token";
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
  const { runResults, bus, enqueuer, embedSecret, auth, admission } = getContainer();

  const token = extractEmbedToken(req.headers);
  const claims = token ? verifyEmbedToken(embedSecret, token) : null;
  if (!claims) return apiError(401, "unauthorized", "invalid or expired embed token");
  // 令牌签名有效还不够:签发它的 key 被吊销、签发人被停用、分享被撤销,都必须立即失效
  let principal: Principal;
  try {
    principal = await auth.resolveEmbed(claims);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { prompt?: unknown };
  const sessionId = claims.sessionId;

  /*
   * 受理:与对话、分支同一套规则。访客在浏览器里花的钱记在签发 Key 的账号上,
   * 所以这把 Key 的调用限流与签发人的额度同样约束嵌入组件 —— 这两条曾经都没有
   * (额度是后来补的,限流此前只拦 invoke)。
   */
  let prompt: string;
  try {
    ({ prompt } = await admission.admit({
      sessionId,
      caller: callerOf(principal),
      prompt: body.prompt,
    }));
  } catch (err) {
    const res = admissionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  return streamRun(req, {
    bus,
    results: runResults,
    sessionId,
    runId,
    enqueue: () => enqueuer.enqueue({ runId, sessionId, prompt }),
  });
}
