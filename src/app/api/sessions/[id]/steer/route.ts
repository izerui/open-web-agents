import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { steerRun } from "@/lib/modules/run/application/steer";
import { checkPromptSize } from "@/lib/modules/run/domain/limits";

/** 调用方给的消息 id:够长免得撞上,只含安全字符 */
const STEER_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 运行中途追加一条消息,不必等这一轮结束。
 *
 * 模型还在干活(之后还会调工具)时,这条会插进当前这一轮;已经在写最终回答时,
 * 会在这一轮回答之后再答一轮。只对工作台与 API 会话开放 —— 接口调用、嵌入组件是一次性输入。
 *
 * 请求体:{ runId, text, id? }。id 是这条消息的稳定标识,重试时必须复用 —— 同一 id 只会入队一次;
 * 不传则由服务端生成(此时无法安全重试)。
 *
 * 答复:
 *   200 delivered        已交给模型
 *   202 pending          已受理,等待上限内没等到结局;最终结局看事件流里的 steer 事件
 *   202 unknown          受理请求没得到答复,可能已经入队 —— 用同一个 id 再请求一次,【不要】改作新消息
 *   409 not_accepting    运行还没开始或已经收尾,这条没有受理 —— 可以作为新消息发送
 *   409 dropped          受理了,但运行在交给模型前结束了 —— 可以作为新消息发送
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, sessions, auth, steerChannel } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    const session = await sessions.get(id);
    if (!session) return apiError(404, "not_found", "session not found");
    // 追加消息同样在用这个智能体 —— 分享撤销后不能继续往运行里塞内容
    await auth.assertCanInvoke(principal, session.agentId);
    if (session.source !== "web" && session.source !== "api") {
      return apiError(409, "not_accepting", "这个会话的运行不接受追加消息");
    }
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as {
    runId?: unknown;
    text?: unknown;
    id?: unknown;
  };
  const runId = typeof body.runId === "string" ? body.runId : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!runId) return apiError(400, "invalid_request", "runId is required");
  if (body.id !== undefined && (typeof body.id !== "string" || !STEER_ID.test(body.id))) {
    return apiError(400, "invalid_request", "id 须为 8~64 个字母、数字、- 或 _");
  }
  const messageId = typeof body.id === "string" ? body.id : randomUUID();
  if (!text) return apiError(400, "invalid_request", "text is required");
  const size = checkPromptSize(text);
  if (!size.ok) return apiError(413, "prompt_too_large", size.reason);

  // 只能往本会话的运行里追加:拿别会话的 runId 不该塞得进去
  const run = await runs.get(runId);
  if (!run || run.sessionId !== id) return apiError(404, "not_found", "该运行不属于本会话或不存在");

  const r = await steerRun({ channel: steerChannel }, { runId, id: messageId, text });
  switch (r.outcome) {
    case "delivered":
      return Response.json({ id: r.id, outcome: r.outcome }, { status: 200 });
    case "pending":
      return Response.json({ id: r.id, outcome: r.outcome }, { status: 202 });
    case "unknown":
      return Response.json(
        {
          id: r.id,
          outcome: r.outcome,
          note: "受理请求没得到答复,这条可能已经入队。请用同一个 id 再请求一次确认,不要改作新消息发送",
        },
        { status: 202 },
      );
    case "not_accepting":
      return apiError(
        409,
        "not_accepting",
        "这一轮没有在接受追加消息(还没开始或已经收尾),请作为新消息发送",
        {
          id: r.id,
        },
      );
    case "dropped":
      return apiError(
        409,
        "dropped",
        "这一轮在交给模型之前已经结束,消息没有送达,请作为新消息发送",
        {
          id: r.id,
        },
      );
  }
}
