// EnginePort 的 claude-agent-sdk 实现。
//
// 可测性设计:类本身依赖【注入的 queryFn】,不 import SDK —— 单测喂录制的消息序列即可回放,
// 不碰网络、不装模型。真实 SDK 的绑定在 default-engine.ts 的工厂里(唯一 import SDK 的地方)。

import {
  extractRunResult,
  hasMeteringBasis,
} from "@/lib/modules/agent-engine/domain/extract-result";
import {
  type ModelMetering,
  addModels,
  addUnattributed,
  mergeCumulative,
  missingOf,
  unattributedOf,
} from "@/lib/modules/agent-engine/domain/model-usage";
import {
  createSubagentLabeler,
  normalizeSdkMessage,
  normalizeStreamEvent,
} from "@/lib/modules/agent-engine/domain/normalize";
import { UnsettledUsage, mergeCost } from "@/lib/modules/agent-engine/domain/partial-usage";
import type { EnginePort, RunResult, TranscriptRange } from "@/lib/modules/agent-engine/ports";
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
  return {
    ...last,
    cost: {
      ...(last.cost ?? {}),
      input,
      output,
      ...combinedMetering(rs),
    },
  };
}

/**
 * modelUsage 是累计快照:最后一条从 modelUsage 读出用量的 result 已覆盖它之前的全部,沿用它而不累加
 * (真实 SDK 探针见 scripts/sdk-probe/model-metering.mjs)。它之后的 result 只有自己这一条的用量
 * (fromResultUsage:取自它的 usage,或它没带计量时按消息观察到的),按模型的明细、未归属用量与
 * 计量缺失逐条相加;一条累计快照都没有就全部相加。
 */
function combinedMetering(rs: RunResult[]): { metering?: ModelMetering } {
  let k = -1;
  let base: ModelMetering | undefined;
  rs.forEach((r, i) => {
    const m = r.cost?.metering;
    // 只有带可用非零计数的累计快照才能覆盖前面已确认的用量:后到的空的、全零的、只有读不出计数的
    // 结果(常见于追加轮没产生新用量就失败的 error result)不能把它们抹成 0 —— 这些结果排在后面,
    // 按下面的逐条相加处理,它们记下的计量缺失照样带上
    if (m && !m.fromResultUsage && hasMeteringBasis(m)) {
      // 累计快照之间按字段合并(不相加):新快照读不出的字段保留此前已确认的值
      base = base ? mergeCumulative(base, m) : m;
      k = i;
    }
  });
  // 最后一条就是 modelUsage 的累计快照:用合并后的(只有它一份时就是它本身)
  if (base && k === rs.length - 1) return { metering: base };
  let models = base?.models ?? [];
  let unattributed = unattributedOf(base) ?? undefined;
  let missing = missingOf(base);
  for (const r of rs.slice(k + 1)) {
    models = addModels(models, r.cost?.metering?.models ?? []);
    unattributed = addUnattributed(unattributed, unattributedOf(r.cost?.metering));
    missing += missingOf(r.cost?.metering);
  }
  // 都没有明细也没有用量:保留最后一条原有的计量(展开 last.cost 时已带上)
  if (models.length === 0 && !unattributed && missing === 0) return {};
  return {
    metering: {
      source: "sdk_model_usage",
      complete: false,
      models,
      ...(unattributed ? { unattributed } : {}),
      ...(missing > 0 ? { missing } : {}),
    },
  };
}

export interface EngineDeps {
  /** agent 子进程共享 HOME(工具缓存跨会话复用)。 */
  sharedHome: string;
  /** 宿主真实 HOME。只用于把禁读目录里的 `~` 展开到平台运维自己的家。 */
  hostHome: string;
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

    // 没等到结算消息(result)的那部分用量:按模型、按消息累计(见 domain/partial-usage.ts)。
    // 取消、失败、多轮中断时按它结算,不能因为没有 result 就当成没花钱
    const unsettled = new UnsettledUsage();
    // 累计费用快照:与中断时 finish() 会返回的一致(已结算的 result 累计 + 之后尚未结算的用量)
    let reportSnapshot = false;
    const snapshot = () => {
      if (!ctx.onCostSnapshot) return;
      const cost = mergeCost(combineResults(results)?.cost, unsettled.cost());
      if (!cost) return;
      try {
        ctx.onCostSnapshot(cost);
      } catch {
        // 快照只是兜底,不能影响运行
      }
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
        unsettled.observe(msg);
        if (carriesUsage(msg)) reportSnapshot = true;

        if (m?.type === "system" && m.subtype === "init") {
          sessionId = m.session_id ?? sessionId;
        } else if (m?.type === "result") {
          let r = extractRunResult(msg, { hasSchema });
          // 结果的计量里没有可用的非零计数(没带计量、全是 0、modelUsage 为空对象,常见于 error result):
          // 它的 0 不代表没花钱。清空之前按消息观察到的用量前,把它们记进这条结果(只算这一条、不完整),
          // 结果里记下的计量缺失一并带上;有可用计数的照旧由 result 覆盖(modelUsage 是累计快照),不重复计
          if (!hasMeteringBasis(r.cost?.metering)) {
            const observed = unsettled.cost();
            if (observed?.metering) {
              const missing = missingOf(r.cost?.metering) + missingOf(observed.metering);
              r = {
                ...r,
                cost: {
                  ...(r.cost ?? {}),
                  input: observed.input,
                  output: observed.output,
                  partial: true,
                  metering: {
                    ...observed.metering,
                    complete: false,
                    fromResultUsage: true,
                    ...(missing > 0 ? { missing } : {}),
                  },
                },
              };
            }
          }
          results.push(r);
          // 到此为止的用量都已记进结果
          unsettled.settled();
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
            onEvent(label(e));
          }
          // assistant 消息处理完毕,重置标记 —— 下一条 assistant 消息重新计数
          if (m?.type === "assistant") hasStreamed = false;
        }
        if (reportSnapshot) {
          reportSnapshot = false;
          snapshot();
        }
      }
    } catch (err) {
      // 【异常不代表没结果】官方文档(cost-tracking)明说:单次 query() 在产出
      // error result 之后【还会再抛一次异常】。若此时只看异常、丢掉已到手的 result,
      // 这一轮真实花掉的钱就永远统计不到,失败原因也从 error_max_turns 这类
      // 具体子类型退化成笼统的 engine_error —— 排查时看到的是"引擎炸了",
      // 而实际上是"轮次用完了",两者的处置完全不同。
      const message = err instanceof Error ? err.message : String(err);
      const error = { kind: abort.signal.aborted ? "aborted" : "engine_error", message };
      return this.finish(combineResults(results), unsettled.cost(), error, sessionId, range());
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
      // 模型不再读输入了:还没交出去的追加消息记为未送达,并告诉界面。
      // 【收尾出错不能往外抛】从 finally 里抛出会盖掉上面已经拿到的结果与花费 ——
      // 一次真实花过钱的运行就成了"引擎异常、用量未知"
      if (steer) {
        try {
          for (const m of await steer.abandon()) {
            onEvent({ kind: "steer", id: m.id, text: m.text, outcome: "dropped" });
          }
        } catch (err) {
          console.warn(
            `[owa] SDK 运行收尾时处理追加消息失败(session=${ctx.sessionId}),结果照常返回:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // 流结束却没收到(最后一轮的)result 消息:被中断或 SDK 异常终止
    const error = abort.signal.aborted
      ? { kind: "aborted", message: "运行被中断" }
      : { kind: "no_result", message: "SDK 未产出 result 消息" };
    return this.finish(combineResults(results), unsettled.cost(), error, sessionId, range());
  }

  /**
   * 收尾:已结算的结果(各条 result 合并)+ 最后一条 result 之后尚未结算的用量。
   * - 最后一条 result 之后没有新的用量:就是那份结果(SDK 在 error result 之后还会再抛一次异常)。
   * - 之后又有一轮在跑(追加消息)却没等到它的 result:这一轮失败,花费 = 已结算 + 这一轮的部分用量,
   *   不返回上一轮的成功状态,也不重复累计上一轮。
   * - 一条 result 都没有:按部分用量;一点用量都没收到时标"用量未知"(请求可能已经发出)。
   */
  private finish(
    done: RunResult | undefined,
    extra: RunResult["cost"],
    error: { kind: string; message: string },
    sessionId: string | undefined,
    transcriptRange: TranscriptRange | undefined,
  ): RunResult {
    if (done && !extra) return { ...done, sessionId, transcriptRange };
    if (done) {
      return {
        ...done,
        status: "failed",
        structured: undefined,
        salvagedFromText: undefined,
        cost: mergeCost(done.cost, extra),
        error,
        sessionId,
        transcriptRange,
      };
    }
    return {
      status: "failed",
      sessionId,
      transcriptRange,
      cost: extra,
      ...(extra ? {} : { usageUnknown: true }),
      error,
    };
  }
}

/** 这条 SDK 消息是否带来了用量变化(流式消息开始/结束、完整 assistant 消息、结算消息) */
function carriesUsage(msg: unknown): boolean {
  const m = msg as {
    type?: string;
    message?: { usage?: unknown };
    event?: { type?: string };
  } | null;
  if (!m) return false;
  if (m.type === "result") return true;
  if (m.type === "assistant") return !!m.message?.usage;
  return (
    m.type === "stream_event" &&
    (m.event?.type === "message_start" || m.event?.type === "message_delta")
  );
}
