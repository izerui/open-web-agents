// EnginePort 的 claude-agent-sdk 实现。
//
// 可测性设计:类本身依赖【注入的 queryFn】,不 import SDK —— 单测喂录制的消息序列即可回放,
// 不碰网络、不装模型。真实 SDK 的绑定在 default-engine.ts 的工厂里(唯一 import SDK 的地方)。

import { extractRunResult } from "@/lib/modules/agent-engine/domain/extract-result";
import {
  createSubagentLabeler,
  normalizeSdkMessage,
  normalizeStreamEvent,
} from "@/lib/modules/agent-engine/domain/normalize";
import type { EnginePort, RunResult, TranscriptRange } from "@/lib/modules/agent-engine/ports";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { buildSdkOptions } from "./options";
import { materializeSkillPlugin } from "./skill-plugin";

export type QueryFn = (args: {
  /** 字符串 = 一次性输入;异步迭代 = 流式输入(运行中途可追加消息)。 */
  prompt: string | AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

/** 流式输入里的一条用户消息。 */
function userMessage(text: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}

/**
 * 一轮里可能有不止一条 result:追加消息落在模型写最终回答的时候,会在本轮回答后再答一轮
 * (scripts/sdk-probe/steer-late.mjs 实测)。结局以【最后一条】为准 —— 状态、正文、结构化结果;
 * 美元取最后一条(SDK 给的是累计值),token 按条累加(SDK 给的是单条的)。
 */
export function combineResults(rs: RunResult[]): RunResult | undefined {
  const last = rs.at(-1);
  if (!last || rs.length === 1) return last;
  const input = rs.reduce((n, r) => n + (r.cost?.input ?? 0), 0);
  const output = rs.reduce((n, r) => n + (r.cost?.output ?? 0), 0);
  return { ...last, cost: { ...(last.cost ?? {}), input, output } };
}

export interface EngineDeps {
  /** agent 子进程共享 HOME(工具缓存跨会话复用)。 */
  sharedHome: string;
  /** 宿主真实 HOME。只用于把禁读目录里的 `~` 展开到平台运维自己的家。 */
  hostHome: string;
  /** 别名 → 真实 modelId 的映射来源。 */
  gateway: ModelGatewayPort;
  /** 是否启用 OS 内核沙箱(macOS 本地开发常关:seatbelt 会吞 stdout)。 */
  sandboxEnabled: boolean;
  /** 是否允许在宿主机启动 stdio MCP 进程。 */
  allowStdioMcp: boolean;
  /** 技能插件的根目录(平台控制、agent 不可写)。不给则不加载技能包。 */
  skillsRoot?: string;
  /**
   * 人工审批钩子(HITL);不给则不启用审批。
   * signal 是本轮的中止信号 —— 运行被取消时挂着的审批必须跟着收场,
   * 否则待审记录会一直留到自己的超时(见 approval/ports.ts)。
   */
  requestApproval?: (
    req: {
      sessionId: string;
      runId?: string;
      toolName: string;
      summary: string;
      reason: string;
      scopes?: { key: string; label: string }[];
    },
    signal?: AbortSignal,
  ) => Promise<{ approved: boolean; message?: string }>;
}

export class ClaudeSdkEngine implements EnginePort {
  constructor(
    private readonly queryFn: QueryFn,
    private readonly deps: EngineDeps,
  ) {}

  async run(
    spec: AgentSpec,
    ctx: RunContext,
    onEvent: (e: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const abort = new AbortController();
    if (signal.aborted) abort.abort();
    const onOuterAbort = () => abort.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    // 子代理归属标签有状态、跨消息记忆映射,故在消息循环外实例化
    const label = createSubagentLabeler();
    const hasSchema = spec.outputSchema !== undefined;

    let sessionId: string | undefined;
    // 每条 result 都留着:第一条只是"关闭追加输入"的时机,不是这一轮的结局
    const results: RunResult[] = [];
    const steer = ctx.steer;
    // 本轮自己产生的主线消息的首尾 uuid(见 RunResult.transcriptRange)。
    // 子代理的消息不在主 transcript 里,不计入
    let firstUuid: string | undefined;
    let lastUuid: string | undefined;
    const trackUuid = (m: { type?: string; uuid?: unknown; parent_tool_use_id?: unknown }) => {
      if (m.type !== "assistant" && m.type !== "user") return;
      if (m.parent_tool_use_id || typeof m.uuid !== "string") return;
      firstUuid ??= m.uuid;
      lastUuid = m.uuid;
    };
    const range = (): TranscriptRange | undefined =>
      firstUuid && lastUuid ? { first: firstUuid, last: lastUuid } : undefined;

    // 按消息累计 token,给"没等到结算消息就中止"的运行一个部分花费。
    // 同一条 assistant 消息可能分多次到达,按 messageId 取最后一次
    const usageByMessage = new Map<string, { input: number; output: number }>();
    let anonymousUsage = { input: 0, output: 0 };
    const trackUsage = (e: AgentEvent) => {
      if (e.kind !== "usage") return;
      const u = { input: e.input + (e.cacheRead ?? 0) + (e.cacheCreation ?? 0), output: e.output };
      if (e.messageId) usageByMessage.set(e.messageId, u);
      else
        anonymousUsage = {
          input: anonymousUsage.input + u.input,
          output: anonymousUsage.output + u.output,
        };
    };
    const partialCost = (): RunResult["cost"] => {
      let input = anonymousUsage.input;
      let output = anonymousUsage.output;
      for (const u of usageByMessage.values()) {
        input += u.input;
        output += u.output;
      }
      return input || output ? { input, output, partial: true } : undefined;
    };

    try {
      const skillPluginPath = this.deps.skillsRoot
        ? await materializeSkillPlugin(this.deps.skillsRoot, spec.skillPackages)
        : undefined;
      /*
       * 有收件箱就用流式输入:先给本轮提示词,之后每取到一条追加消息就交给模型。
       * 关闭(第一条 result 到达)后把已受理的交完就结束输入 —— 输入一结束,SDK 处理完
       * 手上的消息就收尾;不结束的话它会一直等下一条输入。
       */
      const prompt = steer
        ? (async function* () {
            yield userMessage(ctx.prompt);
            for (;;) {
              const m = await steer.next();
              if (!m) return;
              // 此刻模型正在向输入流要下一条:交出去就是送达
              await steer.delivered(m);
              onEvent({ kind: "steer", id: m.id, text: m.text, outcome: "delivered" });
              yield userMessage(m.text);
            }
          })()
        : ctx.prompt;
      const stream = this.queryFn({
        prompt,
        options: buildSdkOptions(spec, ctx, {
          sharedHome: this.deps.sharedHome,
          hostHome: this.deps.hostHome,
          abort,
          slots: this.deps.gateway.slots(),
          sandboxEnabled: this.deps.sandboxEnabled,
          allowStdioMcp: this.deps.allowStdioMcp,
          requestApproval: this.deps.requestApproval,
          skillPluginPath,
        }),
      });

      // 跟踪是否已经通过 stream_event 推送过增量文本/思考 ——
      // 如果推过,完整 assistant 消息到来时要跳过 text/thinking 块,避免重复。
      let hasStreamed = false;

      for await (const msg of stream) {
        const m = msg as {
          type?: string;
          subtype?: string;
          session_id?: string;
          uuid?: unknown;
          parent_tool_use_id?: unknown;
        } | null;
        if (m) trackUuid(m);

        if (m?.type === "system" && m.subtype === "init") {
          sessionId = m.session_id ?? sessionId;
        } else if (m?.type === "result") {
          results.push(extractRunResult(msg, { hasSchema }));
          // 不再受理新的追加;已受理的照样交给模型(可能因此再答一轮、再来一条 result)
          if (steer) void steer.close();
        } else if (m?.type === "stream_event") {
          // 流式增量:逐 token 推送文本 / 思考
          const events = normalizeStreamEvent(msg);
          if (events.length > 0) hasStreamed = true;
          for (const e of events) onEvent(label(e));
        } else {
          // 完整消息(assistant / user)。
          // 流式模式下:text / thinking 已经增量推过,只提取 tool_use / question / usage。
          for (const e of normalizeSdkMessage(msg, { skipStreamed: hasStreamed })) {
            trackUsage(e);
            onEvent(label(e));
          }
          // assistant 消息处理完毕,重置标记 —— 下一条 assistant 消息重新计数
          if (m?.type === "assistant") hasStreamed = false;
        }
      }
    } catch (err) {
      // 【异常不代表没结果】官方文档(cost-tracking)明说:单次 query() 在产出
      // error result 之后【还会再抛一次异常】。若此时只看异常、丢掉已到手的 result,
      // 这一轮真实花掉的钱就永远统计不到,失败原因也从 error_max_turns 这类
      // 具体子类型退化成笼统的 engine_error —— 排查时看到的是"引擎炸了",
      // 而实际上是"轮次用完了",两者的处置完全不同。
      const done = combineResults(results);
      if (done) return { ...done, sessionId, transcriptRange: range() };

      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        sessionId,
        transcriptRange: range(),
        cost: partialCost(),
        error: { kind: abort.signal.aborted ? "aborted" : "engine_error", message },
      };
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
      // 模型不再读输入了:还没交出去的追加消息记为未送达,并告诉界面
      if (steer) {
        for (const m of await steer.abandon()) {
          onEvent({ kind: "steer", id: m.id, text: m.text, outcome: "dropped" });
        }
      }
    }

    const result = combineResults(results);
    // 流结束却没收到 result 消息:被中断或 SDK 异常终止
    if (!result) {
      return {
        status: "failed",
        sessionId,
        transcriptRange: range(),
        cost: partialCost(),
        error: abort.signal.aborted
          ? { kind: "aborted", message: "运行被中断" }
          : { kind: "no_result", message: "SDK 未产出 result 消息" },
      };
    }

    return { ...result, sessionId, transcriptRange: range() };
  }
}
