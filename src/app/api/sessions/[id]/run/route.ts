import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { BusPort } from "@/lib/modules/events/ports";
import {
  type EnqueueRequest,
  PromptTooLarge,
  assertPromptSize,
} from "@/lib/modules/run/application/enqueue";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { type TerminalSource, watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import { assertWithinQuota, quotaErrorResponse } from "@/lib/modules/usage/application/quota-guard";
import type { AgentEvent } from "@/lib/shared";
import { streamRun } from "../../../_lib/run-stream";

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
  const { runs, bus, sessions, auth, users, usage, enqueuer } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);

    const session = await sessions.get(id);
    if (!session) return Response.json({ error: "session not found" }, { status: 404 });
    // 会话归属只说明"这是你的会话";能不能继续跑这个智能体要再查一次 ——
    // 分享被撤销之后,原会话里仍能继续使用别人的提示词与知识库
    await auth.assertCanInvoke(principal, session.agentId);

    /*
     * 额度关卡。
     *
     * 【为什么在这里,而不是只在 worker 里】拦在发起之前才叫"上限" ——
     * 一次运行可能跑很久、烧掉可观的花费,等 worker 跑完再发现超支
     * 只能追认。worker 执行前还会再复核一次(队列里可能积压了很多)。
     *
     * 【为什么按会话的计费账号算】花费记在会话的计费账号上(worker 也按它取凭证),
     * 额度必须查同一个账号 —— 查的和记的不是同一个人,额度就形同虚设。
     */
    const billingUserId =
      session.billingUserId ??
      session.ownerId ??
      (principal.type === "web" ? principal.userId : principal.ownerId);
    if (billingUserId) await assertWithinQuota({ users, usage }, billingUserId);
  } catch (err) {
    const quota = quotaErrorResponse(err);
    if (quota) return quota;
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    stream?: boolean;
  };
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

  // stream 默认 true —— Web 前端不用额外传参;API 调用方传 stream:false 拿 JSON。
  const streaming = body.stream !== false;
  const runId = randomUUID().replace(/-/g, "").slice(0, 24);

  const ctx: RunRouteContext = {
    id,
    runId,
    prompt,
    enqueue: (r) => enqueuer.enqueue(r),
    results: runs,
    bus,
  };
  return streaming ? handleStreaming(req, ctx) : handleBlocking(req, ctx);
}

interface RunRouteContext {
  id: string;
  runId: string;
  prompt: string;
  enqueue(r: EnqueueRequest): Promise<unknown>;
  /** 终态兜底:事件总线上的 result 丢了也能从库里收尾。 */
  results: TerminalSource;
  bus: BusPort;
}

// ─────────────────────────── 流式模式(SSE) ───────────────────────────

/** stream: true → 逐事件 SSE 推送,Web 页面实时打字机效果。实现与嵌入组件共用。 */
function handleStreaming(req: Request, ctx: RunRouteContext) {
  const { id, runId, prompt, enqueue, results, bus } = ctx;
  return streamRun(req, {
    bus,
    results,
    sessionId: id,
    runId,
    enqueue: () => enqueue({ runId, sessionId: id, prompt }),
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
  /** 结构化输出(智能体配了 outputSchema 时才有) */
  structured?: unknown;
  /** 错误摘要(失败时) */
  error?: string;
  /** token 用量 */
  usage: { input: number; output: number };
}

/** stream: false → 等运行完成,返回单个 JSON。适合程序调用。 */
function handleBlocking(req: Request, ctx: RunRouteContext): Promise<Response> {
  const { id, runId, prompt, enqueue, results, bus } = ctx;

  return new Promise<Response>((resolve) => {
    const events: AgentEvent[] = [];
    let settled = false;
    let stopWatch = () => {};

    const settle = (resp: Response) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      stopWatch();
      resolve(resp);
    };

    const settleWithResult = (e: Extract<AgentEvent, { kind: "result" }>) => {
      settle(
        Response.json(assembleBlockingResponse(runId, events), {
          status:
            e.status === "success"
              ? 200
              : e.status === "unknown"
                ? 202
                : e.status === "cancelled"
                  ? 409
                  : 500,
          headers: { "X-Run-Id": runId },
        }),
      );
    };

    const unsubscribe = bus.subscribe(
      topicOf(id, runId),
      (e: AgentEvent) => {
        events.push(e);
        if (e.kind === "result") settleWithResult(e);
      },
      { afterId: "0-0" },
    );

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
        // 事件通道不可用也照常执行:过程事件拿不到,结局由数据库终态送达
        await enqueue({ runId, sessionId: id, prompt });
        // 总线上的 result 丢了也不能让请求永远挂着:库里有终态就用库里的收尾
        stopWatch = watchTerminal(results, runId, (e) => {
          events.push(e);
          settleWithResult(e);
        });
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
  let summary: string | undefined;
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
        summary = e.summary;
        if (e.status !== "success" && e.summary) error = e.summary;
        break;
    }
  }

  const resp: BlockingResponse = {
    runId,
    status,
    // 过程事件丢失(事件通道故障、由数据库兜底收尾)时,至少给出库里的最终文本
    text: textParts.join("") || (status === "success" ? (summary ?? "") : ""),
    toolCalls,
    usage: { input: inputTokens, output: outputTokens },
  };
  if (thinkingParts.length > 0) resp.thinking = thinkingParts.join("");
  if (structured !== undefined && structured !== null) resp.structured = structured;
  if (error) resp.error = error;
  return resp;
}
