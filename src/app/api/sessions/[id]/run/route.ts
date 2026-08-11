import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { assertWithinQuota, quotaErrorResponse } from "@/lib/modules/usage/application/quota-guard";
import type { AgentEvent } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 发起一轮运行:入队后由 worker 异步执行。
 *
 * 支持两种响应模式(通过请求体 `stream` 参数控制):
 *
 * - `stream: true`(默认):SSE 逐事件推送,适合 Web 页面实时打字机效果。
 *   前端用 fetch + getReader 手工拆帧(EventSource 带不了 Authorization 头)。
 *
 * - `stream: false`:等运行完成后返回单个 JSON,适合程序调用 / 接口集成。
 *   响应包含完整文本、工具调用记录、结构化输出和用量统计。
 *
 * 关键差别 —— 运行**不绑定在这个 HTTP 请求上**:客户端断开只是停止接收事件,
 * agent 仍在 worker 里跑完并落库,重新连 /events 可继续观察(joinStream)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, bus, sessions, auth, users, usage } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);

    /*
     * 额度关卡。
     *
     * 【为什么在这里,而不是在 worker 里】拦在发起之前才叫"上限" ——
     * 一次运行可能跑很久、烧掉可观的花费,等 worker 跑完再发现超支
     * 只能追认。这里多一次查询,换的是超支根本不会发生。
     *
     * 【为什么按 principal 的归属人算,而不是会话归属】会话可能是
     * 别人分享/系统建的,但花费永远记在发起这次运行的账号头上。
     */
    const ownerId = principal.type === "web" ? principal.userId : principal.ownerId;
    if (ownerId) await assertWithinQuota({ users, usage }, ownerId);
  } catch (err) {
    const quota = quotaErrorResponse(err);
    if (quota) return quota;
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (!(await sessions.get(id))) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    stream?: boolean;
  };
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  // stream 默认 true —— Web 前端不用额外传参;API 调用方传 stream:false 拿 JSON。
  const streaming = body.stream !== false;
  const runId = randomUUID().replace(/-/g, "").slice(0, 24);

  if (streaming) {
    return handleStreaming(req, { id, runId, prompt, runs, bus });
  }
  return handleBlocking(req, { id, runId, prompt, runs, bus });
}

// ─────────────────────────── 流式模式(SSE) ───────────────────────────

/** stream: true → 逐事件 SSE 推送,Web 页面实时打字机效果。 */
function handleStreaming(
  req: Request,
  ctx: { id: string; runId: string; prompt: string; runs: any; bus: any },
) {
  const { id, runId, prompt, runs, bus } = ctx;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      // 先订阅再入队,避免 worker 抢先跑完导致漏掉开头的事件
      const unsubscribe = bus.subscribe(topicOf(id), (e: AgentEvent) => {
        if (e.kind === "result" && e.runId !== undefined && e.runId !== runId) return;
        send(e);
        if (e.kind === "result") finish();
      });

      req.signal.addEventListener("abort", finish, { once: true });

      try {
        let busUsable = true;
        try {
          await bus.ready?.(topicOf(id));
        } catch {
          busUsable = false;
          send({ kind: "status", label: "事件通道不可用,本次无实时过程", state: "degraded" });
        }
        await runs.create({ id: runId, sessionId: id, prompt });
        send({ kind: "status", label: "已入队", state: "pending" });

        if (!busUsable) {
          send({
            kind: "result",
            status: "unknown",
            summary: "任务已提交,但事件通道不可用 —— 请稍后轮询结果接口查看结局",
          });
          finish();
        }
      } catch (err) {
        send({
          kind: "result",
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
        });
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
    },
  });
}

// ─────────────────────────── 阻塞模式(JSON) ───────────────────────────

/**
 * 汇聚后的 JSON 响应形状。
 *
 * 设计参考 OpenAI / Anthropic 的非流式响应:
 * 一个请求一个 JSON,包含完整结果、过程记录和元数据。
 */
interface BlockingResponse {
  /** 运行 ID */
  runId: string;
  /** 终态:success / failed / unknown */
  status: string;
  /** 完整回复文本(所有 text 事件拼接) */
  text: string;
  /** 思考过程(所有 thinking 事件拼接;无则省略) */
  thinking?: string;
  /** 工具调用记录 */
  toolCalls: {
    tool: string;
    input: unknown;
    toolUseId?: string;
    result?: string;
    isError?: boolean;
  }[];
  /** 结构化输出(助手配了 outputSchema 时才有) */
  structured?: unknown;
  /** 错误摘要(失败时) */
  error?: string;
  /** token 用量 */
  usage: { input: number; output: number };
}

/** stream: false → 等运行完成,返回单个 JSON。适合程序调用。 */
function handleBlocking(
  req: Request,
  ctx: { id: string; runId: string; prompt: string; runs: any; bus: any },
): Promise<Response> {
  const { id, runId, prompt, runs, bus } = ctx;

  return new Promise<Response>((resolve) => {
    const events: AgentEvent[] = [];
    let settled = false;

    const settle = (resp: Response) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(resp);
    };

    const unsubscribe = bus.subscribe(topicOf(id), (e: AgentEvent) => {
      // 只认自己的终态
      if (e.kind === "result" && e.runId !== undefined && e.runId !== runId) return;
      events.push(e);

      if (e.kind === "result") {
        settle(
          Response.json(assembleBlockingResponse(runId, events), {
            status: e.status === "success" ? 200 : e.status === "unknown" ? 202 : 500,
            headers: { "X-Run-Id": runId },
          }),
        );
      }
    });

    // 客户端断开 → 不再等结果(但运行仍在后台继续)
    req.signal.addEventListener(
      "abort",
      () => {
        settle(Response.json({ error: "client disconnected", runId }, { status: 499 }));
      },
      { once: true },
    );

    // 入队
    (async () => {
      try {
        try {
          await bus.ready?.(topicOf(id));
        } catch {
          settle(
            Response.json(
              { error: "事件通道不可用,请改用流式模式或稍后轮询", runId },
              { status: 503 },
            ),
          );
          return;
        }
        await runs.create({ id: runId, sessionId: id, prompt });
      } catch (err) {
        settle(
          Response.json(
            {
              runId,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              text: "",
              toolCalls: [],
              usage: { input: 0, output: 0 },
            },
            { status: 500, headers: { "X-Run-Id": runId } },
          ),
        );
      }
    })();
  });
}

/** 把收集到的事件流组装成一个 BlockingResponse。 */
function assembleBlockingResponse(runId: string, events: AgentEvent[]): BlockingResponse {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: BlockingResponse["toolCalls"] = [];
  const toolMap = new Map<string, (typeof toolCalls)[number]>();
  let structured: unknown;
  let status = "unknown";
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const e of events) {
    switch (e.kind) {
      case "text":
        textParts.push(e.text);
        break;
      case "thinking":
        thinkingParts.push(e.text);
        break;
      case "tool_use": {
        const call = {
          tool: e.tool,
          input: e.input,
          toolUseId: e.toolUseId,
        };
        if (e.toolUseId) toolMap.set(e.toolUseId, call);
        toolCalls.push(call);
        break;
      }
      case "tool_result": {
        const call = e.toolUseId ? toolMap.get(e.toolUseId) : undefined;
        if (call) {
          call.result = e.text;
          call.isError = e.isError === true;
        }
        break;
      }
      case "usage":
        inputTokens += e.input;
        outputTokens += e.output;
        break;
      case "result":
        status = e.status;
        structured = e.structured;
        if (e.status !== "success" && e.summary) error = e.summary;
        break;
    }
  }

  const resp: BlockingResponse = {
    runId,
    status,
    text: textParts.join(""),
    toolCalls,
    usage: { input: inputTokens, output: outputTokens },
  };
  if (thinkingParts.length > 0) resp.thinking = thinkingParts.join("");
  if (structured !== undefined && structured !== null) resp.structured = structured;
  if (error) resp.error = error;
  return resp;
}
