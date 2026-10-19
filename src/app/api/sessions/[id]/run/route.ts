import { randomUUID } from "node:crypto";
import { admissionErrorResponse, callerOf } from "@/app/api/_lib/admission";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { type TaskFile, taskFilesForResult } from "@/lib/modules/artifacts/application/task-files";
import type { BusPort } from "@/lib/modules/events/ports";
import type { EnqueueRequest } from "@/lib/modules/run/application/enqueue";
import { topicOf } from "@/lib/modules/run/application/orchestrator";
import { watchTerminal } from "@/lib/modules/run/application/terminal-watch";
import { type RunRecord, type RunResult, toRunResult } from "@/lib/modules/run/domain/run-result";
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
  const { runs, bus, sessions, auth, enqueuer, admission, storage } = getContainer();

  let principal: Principal;
  try {
    principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    const session = await sessions.get(id);
    if (!session) return apiError(404, "not_found", "session not found");
    // 会话归属只说明"这是你的会话";能不能继续跑这个智能体要再查一次 ——
    // 分享被撤销之后,原会话里仍能继续使用别人的提示词与知识库
    await auth.assertCanInvoke(principal, session.agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as {
    prompt?: unknown;
    /** 结构化输入:API Key 建的会话里,声明了 inputSchema 的智能体按它传 */
    input?: unknown;
    stream?: boolean;
  };

  /*
   * 受理:计费账号、Key 调用限流、额度、输入规范化与契约 —— 与分支重跑同一套规则
   * (见 run/application/admission.ts)。额度拦在发起之前才叫"上限";worker 执行前还会再复核。
   */
  let prompt: string;
  try {
    ({ prompt } = await admission.admit({
      sessionId: id,
      caller: callerOf(principal),
      prompt: body.prompt,
      input: body.input,
    }));
  } catch (err) {
    const res = admissionErrorResponse(err);
    if (res) return res;
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
    // 查会话也在清单的等待上限之内:数据库不返回时阻塞响应不能被它挂住
    files: () =>
      taskFilesForResult(storage, () =>
        sessions.get(id).then((s) => (s ? { sessionId: id, workspaceDir: s.workspaceDir } : null)),
      ),
  };
  return streaming ? handleStreaming(req, ctx) : handleBlocking(req, ctx);
}

interface RunRouteContext {
  id: string;
  runId: string;
  prompt: string;
  enqueue(r: EnqueueRequest): Promise<unknown>;
  /** 终态兜底与结果契约的数据源:事件总线上的 result 丢了也能从库里收尾。 */
  results: { getResult(id: string): Promise<RunRecord | null> };
  /** 工作目录的文件清单(阻塞响应附带;有等待上限,失败为 null) */
  files(): Promise<{ files: TaskFile[] | null; filesTruncated: boolean }>;
  bus: BusPort;
}

// ─────────────────────────── 流式模式(SSE) ───────────────────────────

/** stream: true → 逐事件 SSE 推送,Web 页面实时打字机效果。 */
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
 * 阻塞模式的 JSON 响应 = 对外运行结果契约(与 /result、webhook 同一份字段,
 * 见 run/domain/run-result.ts)+ 过程信息(工具调用、思考、token 用量)。
 */
type BlockingResponse = RunResult & {
  /** 运行 ID(= taskId) */
  runId: string;
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
  /** 本轮各次模型调用的 token 用量合计 */
  usage: { input: number; output: number };
};

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

    const settleWithResult = async (e: Extract<AgentEvent, { kind: "result" }>) => {
      // 结果契约以库为准(worker 先落库再发 result 事件,这里读到的必是终态);
      // 读失败或超过等待上限都退回用事件拼 —— 运行已经结束,不能因为读库慢就让请求挂着
      const record = await readRecordBounded(results, runId);
      const files = await ctx.files();
      settle(
        Response.json(
          { ...assembleBlockingResponse(runId, events, record), ...files },
          {
            status:
              e.status === "success"
                ? 200
                : e.status === "unknown"
                  ? 202
                  : e.status === "cancelled"
                    ? 409
                    : 500,
            headers: { "X-Run-Id": runId },
          },
        ),
      );
    };

    const unsubscribe = bus.subscribe(
      topicOf(id, runId),
      (e: AgentEvent) => {
        events.push(e);
        if (e.kind === "result") void settleWithResult(e);
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
          void settleWithResult(e);
        });
      } catch (err) {
        settle(
          Response.json(
            {
              runId,
              taskId: runId,
              status: "failed",
              done: true,
              error: {
                kind: "enqueue_failed",
                message: err instanceof Error ? err.message : String(err),
              },
              text: null,
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

/** 终态事件到了之后补读结果记录的等待上限。 */
const RESULT_READ_TIMEOUT_MS = 2_000;

/**
 * 有等待上限的补读:失败或超时返回 null,由调用方用事件兜底。
 * 【超时只是不再等】底层查询没有取消,之后仍可能返回(结果被丢弃)或一直占着连接直到驱动报错。
 */
async function readRecordBounded(
  results: RunRouteContext["results"],
  runId: string,
): Promise<RunRecord | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      results.getResult(runId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[owa][run] 补读运行结果超过 ${RESULT_READ_TIMEOUT_MS}ms 未返回,改用事件拼装响应(run=${runId};底层查询未取消)`,
          );
          resolve(null);
        }, RESULT_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 结果契约取自库里的记录(record),过程信息取自事件流;记录缺失时用事件兜底。 */
function assembleBlockingResponse(
  runId: string,
  events: AgentEvent[],
  record: RunRecord | null,
): BlockingResponse {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: BlockingResponse["toolCalls"] = [];
  const toolMap = new Map<string, (typeof toolCalls)[number]>();
  let inputTokens = 0;
  let outputTokens = 0;
  let last: Extract<AgentEvent, { kind: "result" }> | undefined;

  for (const e of events) {
    switch (e.kind) {
      case "text":
        textParts.push(e.text);
        break;
      case "thinking":
        thinkingParts.push(e.text);
        break;
      case "tool_use": {
        const call = { tool: e.tool, input: e.input, toolUseId: e.toolUseId };
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
        last = e;
        break;
    }
  }

  const base: RunResult = record
    ? toRunResult(record)
    : {
        // 读库失败时的兜底:只有事件里拿得到的字段
        taskId: runId,
        // 结局未知(unknown)对外就是"还没结束":done=false,调用方可再按 taskId 轮询
        status: !last || last.status === "unknown" ? "running" : last.status,
        done: !!last && last.status !== "unknown",
        agentVersion: null,
        structured: last?.structured ?? null,
        salvaged: false,
        // 成功终态的 summary 就是最终正文(总线事件与库里补发的终态都这样带);过程增量可能丢,
        // 只作退路。失败 / 取消时 summary 是错误信息,归到 error,不当正文
        text: (last?.status === "success" ? last.summary : undefined) || textParts.join("") || null,
        error:
          last && last.status !== "success"
            ? { kind: "unknown", message: last.summary ?? "运行未成功" }
            : null,
        cost: null,
        startedAt: null,
        endedAt: null,
      };
  const resp: BlockingResponse = {
    ...base,
    runId,
    // 以库里的最终回答为准;库里没有时用过程文本拼出来
    text: base.text ?? (textParts.join("") || null),
    toolCalls,
    usage: { input: inputTokens, output: outputTokens },
  };
  if (thinkingParts.length > 0) resp.thinking = thinkingParts.join("");
  return resp;
}
