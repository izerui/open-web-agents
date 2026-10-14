import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { extractEmbedToken, verifyEmbedToken } from "@/lib/modules/integration/domain/embed-token";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { cancellableRunIds } from "@/lib/modules/run/domain/cancel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 嵌入组件里的"停止"。
 *
 * 曾经 widget 没有停止按钮:关掉页面只是断开事件流,运行在服务端照常跑完、照常扣费。
 * 嵌入令牌绑定单个会话,这里也只能取消该会话里未结束的运行。
 */
export async function POST(req: Request) {
  const { runs, bus, embedSecret, auth, cancelSignal } = getContainer();

  const token = extractEmbedToken(req.headers);
  const claims = token ? verifyEmbedToken(embedSecret, token) : null;
  if (!claims) {
    return Response.json({ error: "invalid or expired embed token" }, { status: 401 });
  }
  try {
    await auth.resolveEmbed(claims);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { runId?: string };
  const targets = cancellableRunIds(await runs.listBySession(claims.sessionId), body.runId);
  const cancelled: string[] = [];
  for (const runId of targets) {
    if (!(await runs.cancel(runId))) continue;
    // 落库之后立即通知执行它的 worker 停下,而不是等下一次心跳(最多 15 秒)
    await cancelSignal.publish(runId);
    cancelled.push(runId);
    await bus
      .publish(topicOf(claims.sessionId, runId), {
        kind: "result",
        status: "cancelled",
        summary: "已停止",
        runId,
      })
      .catch(() => {});
  }
  return Response.json({ cancelled });
}
