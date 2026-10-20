// 运行编排(Application 层):人用对话与系统 invoke 共用的【同一个运行内核】。
// 只依赖端口接口,不碰框架与 IO 细节 —— 用内存 fake 即可完整单测。

import type { EnginePort, RunResult, TranscriptRange } from "@/lib/modules/agent-engine/ports";
import {
  MissingRequiredVariables,
  buildSpec,
  checkRequiredVariables,
  splitVariables,
} from "@/lib/modules/agent/domain/build-spec";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import { validateStructured } from "@/lib/modules/agent/domain/validate-output";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import type { UsageTokens } from "@/lib/modules/billing/application/run-charging";
import type { BusPort } from "@/lib/modules/events/ports";
import type {
  ResolveRequest,
  ResolvedRun,
} from "@/lib/modules/model-gateway/application/model-resolver";
import { ModelUnavailable } from "@/lib/modules/model-gateway/domain/resolve-run-models";
import type { SteerChannel } from "@/lib/modules/run/ports";
import type { SessionRepo } from "@/lib/modules/session/ports";
import {
  type AgentEvent,
  BrandedError,
  type ModelRef,
  type PinnedPricing,
  type RunPricing,
} from "@/lib/shared";
import { EventCoalescer } from "./event-coalescer";
import { ChannelSteerInbox } from "./steer-inbox";

/** 一次运行请求。人用对话与系统 invoke 都收敛成这一个 Command。 */
export interface RunCommand {
  sessionId: string;
  prompt: string;
  /** 队列里的 run id(worker 执行时带上;内联执行可不传)。 */
  runId?: string;
  /** 请求级覆盖(三级链最高优先)。 */
  override?: { model?: ModelRef };
  /**
   * 受理时锁定的模型绑定与价目版本;有就按它执行。受理时模型就不可用的,是"不可执行"标记,照此失败。
   * 只有没有快照的旧任务才按配置现解析。
   */
  pricing?: PinnedPricing;
  /**
   * 入队时的智能体配置快照。有就按它跑,而不是读执行时的"当前配置" ——
   * 排队期间配置被改,不该改变已经受理的任务。迁移前的旧任务没有快照,回退到当前配置。
   */
  agentConfig?: AgentConfig;
}

export interface OrchestratorDeps {
  sessions: SessionRepo;
  agents: AgentRepo;
  engine: EnginePort;
  bus: BusPort;
  /** 按智能体配置解析本次运行的提供者、真实模型与凭证(凭证只在这里解密)。 */
  resolveModels: (req: ResolveRequest & { pinned?: PinnedPricing | null }) => Promise<ResolvedRun>;
  /**
   * 运行中每次模型请求返回后报告累计 token;返回 "stop" 表示积分不够继续(正式模式),
   * 编排在这一步之后中止引擎。不给则不做运行中计费检查。
   */
  chargeProgress?: (runId: string, tokens: UsageTokens) => Promise<"continue" | "stop">;
  /**
   * 引擎一交回费用就落恢复记录(见 run/ports.ts 的 CostOutbox),早于之后任何可能卡住的数据库调用
   * (运行中计费检查的收尾、记录会话锚点)。失败只报告,不影响运行;worker 之后还会再存一次。
   */
  saveCostRecovery?: (runId: string, cost: NonNullable<RunResult["cost"]>) => Promise<void>;
  /**
   * 写运行中的累计用量快照(见 RunContext.onCostSnapshot)。同一次运行只保留最新一份待写:
   * 前一次还没写完时,新的覆盖旧的。写失败只报告,不影响运行。
   */
  saveUsageSnapshot?: (runId: string, cost: NonNullable<RunResult["cost"]>) => Promise<void>;
  /** 传给 agent 子进程的基础环境。 */
  baseEnv?: Record<string, string>;
  /**
   * 取该运行自带的 resume 锚点(分支重跑用)。
   * anchored=true 时【必须】用它给出的锚点 —— 包括"从零重开"的空锚点;
   * 否则回退到会话最新锚点,分支就会串回主线。
   */
  runAnchor?: (runId: string) => Promise<{ anchored: boolean; anchor?: string; resumeAt?: string }>;
  /**
   * 记录本轮产生的 SDK 会话到该运行上,供后续分支续接;
   * range 是本轮在 transcript 里的那一段,供历史回放只读本轮(见 RunResult.transcriptRange)。
   */
  recordRunSession?: (
    runId: string,
    sdkSessionId: string,
    range?: TranscriptRange,
  ) => Promise<void>;
  /** 运行中途追加消息的通道;不给则所有运行都是一次性输入。 */
  steerChannel?: SteerChannel;
  /** 记录本轮实际使用的起跑锚点,供审计。 */
  recordRunAnchor?: (runId: string, anchor: string | null) => Promise<void>;
  /**
   * 运行前确保工作目录存在。目录可能已被 GC 整体清理(会话超过保留期未活动):
   * 会话与对话历史还在,只是文件没了 —— 在同一路径重建空目录继续,而不是让这一轮
   * 因为 cwd 不存在而失败。
   */
  ensureWorkspace?: (sessionId: string, dir: string) => Promise<void>;
  /**
   * 按本轮输入检索智能体知识库,返回可直接注入提示词的文本(无命中则空串)。
   * 检索失败不该让整轮运行失败 —— 降级成"没有知识库"继续跑。
   */
  retrieveKnowledge?: (agentId: string, query: string) => Promise<string>;
  /** 按智能体+计费账号读取变量值,运行前注入配置。 */
  resolveVariables?: (agentId: string, userId: string) => Promise<Record<string, string>>;
}

/**
 * 引擎已经启动之后出的错:引擎本身抛错,或引擎交回结果后收尾时出错。模型已经被调用过 ——
 * 带着费用的照常记账;没有费用的用量不得而知,计费只能暂记,不能当成零用量结清。
 * 引擎启动前的失败不用它,那些确认没有调用模型。
 */
export class EngineRunFailed extends BrandedError {
  static readonly brand = Symbol.for("owa.error.EngineRunFailed");
  constructor(
    readonly cause: unknown,
    /** 引擎已经交回的费用(引擎返回之后、收尾时才出错的情况);没有为空 */
    readonly cost?: RunResult["cost"],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "EngineRunFailed";
  }
}

/** 每个运行一条 Stream,避免并发运行的事件和游标相互污染。 */
export function topicOf(sessionId: string, runId?: string): string {
  return `session:${sessionId}:run:${runId ?? "adhoc"}`;
}

export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * 执行一轮:解析凭证 → 组装 spec → 跑引擎 → 事件全程上总线 → 记 sdkSessionId 供下轮 resume。
   * 事件在产生的同时发布,订阅者(SSE)实时可见。
   */
  async execute(cmd: RunCommand, signal: AbortSignal): Promise<RunResult> {
    const session = await this.deps.sessions.get(cmd.sessionId);
    if (!session) throw new Error(`session not found: ${cmd.sessionId}`);

    let config = cmd.agentConfig;
    if (!config) {
      const agent = await this.deps.agents.get(session.agentId);
      if (!agent) throw new Error(`agent not found: ${session.agentId}`);
      config = agent.config;
    }

    // 模型在执行时解析:排队期间模型或提供者被停用的,这里如实失败,不去调用。
    // 设计会话不接受调用方覆盖模型。
    let resolved: ResolvedRun;
    try {
      resolved = await this.deps.resolveModels({
        main: config.model,
        override: session.source === "design" ? undefined : cmd.override?.model,
        subagents: config.subagents?.map((s) => ({ name: s.name, model: s.model })),
        pinned: cmd.pricing ?? null,
      });
    } catch (err) {
      if (err instanceof ModelUnavailable) {
        return { status: "failed", error: { kind: "model_unavailable", message: err.message } };
      }
      throw err;
    }
    const { binding, credentials } = resolved;

    // 分支重跑:优先用该运行自己的锚点。只有它没有明确意图时才回退到会话最新状态
    let resumeSessionId = session.sdkSessionId;
    // "从某一轮重来":在那份会话里从这条消息之后接着跑,并分到新会话(不动原对话)
    let resumeSessionAt: string | undefined;
    if (cmd.runId && this.deps.runAnchor) {
      // 【读失败不能当成"没有锚点意图"】—— 那会落回会话最新锚点,于是"从零重开"
      // 的分支恢复了完整历史对话,悄悄串回主线(见本文件顶部对锚点语义的说明),
      // 而且随后还会把这个错误锚点写进审计轨迹,事后无从诊断。
      // DB 读失败在这里不是可降级条件,宁可让这一轮失败。
      const a = await this.deps.runAnchor(cmd.runId);
      if (a.anchored) {
        resumeSessionId = a.anchor;
        resumeSessionAt = a.anchor ? a.resumeAt : undefined;
      }
    }

    // 如实记下这一轮到底从哪儿起跑 —— 事后排查"为什么它记得/不记得某件事"全靠它
    if (cmd.runId) {
      await this.deps.recordRunAnchor?.(cmd.runId, resumeSessionId ?? null).catch(() => {});
    }

    await this.deps.ensureWorkspace?.(session.id, session.workspaceDir);

    const ctx = {
      designMode: session.source === "design",
      sessionId: cmd.sessionId,
      runId: cmd.runId,
      workspaceDir: session.workspaceDir,
      prompt: cmd.prompt,
      resumeSessionId,
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
      unattended: session.unattended === true,
      // 有没有人能审批取决于入口:接口调用与评测无人值守,按智能体对无人值守的配置走
      approvalPolicy:
        session.source === "invoke" || session.source === "eval"
          ? (config.unattendedApproval ?? "allow")
          : ("ask" as const),
      credentials,
      modelSlots: binding.slots,
      ...(cmd.runId && this.deps.saveUsageSnapshot
        ? {
            onCostSnapshot: snapshotWriter(cmd.runId, binding.pricing, this.deps.saveUsageSnapshot),
          }
        : {}),
      env: { ...(this.deps.baseEnv ?? {}) },
    };
    // 知识检索:命中才注入。检索挂了就当没有知识库,不牵连整轮运行
    const knowledgeContext = this.deps.retrieveKnowledge
      ? await this.deps.retrieveKnowledge(session.agentId, cmd.prompt).catch(() => "")
      : "";

    const resolvedVariables =
      session.billingUserId && this.deps.resolveVariables
        ? await this.deps.resolveVariables(session.agentId, session.billingUserId)
        : {};

    const missing = checkRequiredVariables(config.variables, resolvedVariables);
    if (missing.length > 0) throw new MissingRequiredVariables(missing);

    const { secretEnv } = splitVariables(config.variables, resolvedVariables);
    if (Object.keys(secretEnv).length > 0) {
      Object.assign(ctx.env, secretEnv);
    }

    const spec = buildSpec(config, ctx, {
      model: { ref: binding.main.ref, modelId: binding.main.modelId },
      subagentModels: Object.fromEntries(
        Object.entries(binding.subagents).map(([name, m]) => [name, m.modelId]),
      ),
      knowledgeContext,
      resolvedVariables,
    });

    const topic = topicOf(cmd.sessionId, cmd.runId);

    // 事件投递是辅助能力:Redis 暂时不可用只影响实时过程,不能让已经执行的任务失败。
    const coalescer = new EventCoalescer((e) => {
      void this.deps.bus.publish(topic, e).catch(() => {});
    });
    // 运行中计费:按消息去重累计用量(同一条消息会分几次到达,取最后一次),
    // 交给计费判断是否追加冻结;积分不够继续就在这一步之后中止引擎。
    const engineAbort = new AbortController();
    const onOuterAbort = () => engineAbort.abort(signal.reason);
    if (signal.aborted) engineAbort.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    let stoppedForCredits = false;
    const usageByMessage = new Map<string, UsageTokens>();
    let anonymousUsage: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let chargeChain: Promise<void> = Promise.resolve();
    const trackCharge = (e: AgentEvent) => {
      if (e.kind !== "usage" || !cmd.runId || !this.deps.chargeProgress) return;
      const u = {
        input: e.input,
        output: e.output,
        cacheRead: e.cacheRead ?? 0,
        cacheWrite: e.cacheCreation ?? 0,
      };
      if (e.messageId) usageByMessage.set(e.messageId, u);
      else {
        anonymousUsage = {
          input: anonymousUsage.input + u.input,
          output: anonymousUsage.output + u.output,
          cacheRead: anonymousUsage.cacheRead + u.cacheRead,
          cacheWrite: anonymousUsage.cacheWrite + u.cacheWrite,
        };
      }
      const total = { ...anonymousUsage };
      for (const v of usageByMessage.values()) {
        total.input += v.input;
        total.output += v.output;
        total.cacheRead += v.cacheRead;
        total.cacheWrite += v.cacheWrite;
      }
      const runId = cmd.runId;
      const progress = this.deps.chargeProgress;
      chargeChain = chargeChain.then(async () => {
        if (stoppedForCredits) return;
        // 计费检查失败不能拖垮运行:结束时照常按实际用量结算
        const verdict = await progress(runId, total).catch(() => "continue" as const);
        if (verdict === "stop") {
          stoppedForCredits = true;
          engineAbort.abort("insufficient_credits");
        }
      });
    };
    const publish = (e: AgentEvent) => {
      trackCharge(e);
      coalescer.push(e);
    };

    publish({ kind: "status", label: "运行中", state: "running" });
    // 让用户看得到"这次回答参考了知识库",而不是凭空多出一些内容
    if (knowledgeContext) {
      publish({ kind: "status", label: "已引用知识库资料", state: "knowledge" });
    }

    // 准备阶段(查库、检索)期间就被取消或超时了:不要再启动引擎去花钱
    if (signal.aborted) {
      return { status: "failed", error: { kind: "aborted", message: "运行在启动前已被中止" } };
    }

    // 运行中途追加消息:只给有人在对话的入口(工作台、API 会话)。接口调用是一次性输入。
    // 开不了(通道不可用)就不接受追加,运行照常
    const steer =
      cmd.runId && this.deps.steerChannel && (session.source === "web" || session.source === "api")
        ? await ChannelSteerInbox.open(this.deps.steerChannel, cmd.runId)
        : null;

    // 引擎一旦启动,之后出的任何错都带上"已调用引擎"与(若已交回)费用 ——
    // worker 据此判断:有费用照常记账,没有费用按"用量未知"暂记,不会当成零用量结清
    let engineCost: RunResult["cost"] | undefined;
    try {
      let result: RunResult;
      try {
        try {
          result = await this.deps.engine.run(
            spec,
            steer ? { ...ctx, steer } : ctx,
            publish,
            engineAbort.signal,
          );
        } catch (err) {
          throw new EngineRunFailed(err);
        }
        // 带上锁定的价目引用(结算按它计价)后立刻落恢复记录 —— 下面的等待都可能碰数据库
        if (result.cost) {
          const cost = { ...result.cost, pricing: binding.pricing };
          result = { ...result, cost };
          engineCost = cost;
          if (cmd.runId && this.deps.saveCostRecovery) {
            await this.deps.saveCostRecovery(cmd.runId, cost).catch((err) => {
              console.warn(
                `[owa] 费用恢复记录写入失败(run=${cmd.runId}),由 worker 再试:`,
                err instanceof Error ? err.message : err,
              );
            });
          }
        }
        await chargeChain;
        if (stoppedForCredits) {
          result = {
            ...result,
            status: "failed",
            structured: undefined,
            error: { kind: "insufficient_credits", message: "积分不足,已停止" },
          };
        }
      } finally {
        signal.removeEventListener("abort", onOuterAbort);
        // 引擎正常会自己收尾;它中途抛出时这里兜底:还没交出去的追加消息记为未送达。
        // 【收尾出错不能往外抛】引擎此时可能已经交回了结果与花费,从 finally 里抛出会把它们整个丢掉,
        // 一次真实花过钱的运行就变成"没有用量"。追加消息的结局记不上,代价小得多
        if (steer) {
          try {
            for (const m of await steer.abandon()) {
              publish({ kind: "steer", id: m.id, text: m.text, outcome: "dropped" });
            }
          } catch (err) {
            console.warn(
              `[owa] 运行收尾时处理追加消息失败(run=${cmd.runId}),结果照常保留:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        // 最后一段攒着的文本必须冲出去,否则回答会少个尾巴
        try {
          coalescer.flush();
        } catch {
          // 事件投递是辅助能力,不影响结果
        }
      }

      // 记下本次运行所属提供者与价目版本:积分按当时的价格算,不受之后调价影响
      // (引擎返回时已带上;收尾时改写过结果的,这里再确保一次)
      if (result.cost && !result.cost.pricing) {
        result = { ...result, cost: { ...result.cost, pricing: binding.pricing } };
      }

      if (result.sessionId) {
        // 会话的"当前位置"跟着最新一次运行走。
        //
        // 【这里绝不能裸 await】—— 引擎已经跑完、钱已经花了,结果就在局部变量里。
        // 这一条 UPDATE 撞上瞬时 DB 错误就会让 execute 在发布 result 事件之前抛出:
        // SSE 客户端永久挂起、webhook 不触发、worker 把这次成功记成 worker_error,
        // 而真实结果不可恢复。记不住锚点只影响下一轮 resume,代价小得多。
        try {
          await this.deps.sessions.setSdkSessionId(cmd.sessionId, result.sessionId);
        } catch (err) {
          console.warn(
            `[owa] 记录会话锚点失败(session=${cmd.sessionId}),下一轮将从零开始:`,
            err instanceof Error ? err.message : err,
          );
        }
        // 同时记到本次运行上 —— 将来要从这一轮分叉时需要它
        if (cmd.runId) {
          await this.deps
            .recordRunSession?.(cmd.runId, result.sessionId, result.transcriptRange)
            .catch(() => {});
        }
      }

      // 接口契约守门:声明了 outputSchema 就必须真的符合它,否则调用方会拿到"半对"的结果
      if (result.status === "success" && spec.outputSchema) {
        const verdict = validateStructured(spec.outputSchema, result.structured);
        if (!verdict.ok) {
          result = {
            ...result,
            status: "failed",
            // 【必须置空】—— 展开 result 会把不合格的 structured 一起带过来,
            // 于是 /result 接口同时返回 status:"failed" 与一份 structured。
            // 按 ports.ts 对该字段的契约("仅当产出结构化输出时存在")去判
            // `structured != null` 的调用方,会消费平台已经判定为非法的数据。
            structured: undefined,
            error: {
              kind: "schema_mismatch",
              message: `结构化结果不符 outputSchema: ${verdict.errors?.join("; ")}`,
            },
          };
        }
      }

      // 【这里不发布 result 事件,也不触发 webhook】—— 终态以数据库为准:
      // worker 把终态写进库之后才通知(见 worker.ts 的 onFinalized)。
      // 曾经在这里发,早于落库,且分不清本轮是不是已被取消或失租。
      return result;
    } catch (err) {
      if (err instanceof EngineRunFailed) throw err;
      throw new EngineRunFailed(err, engineCost);
    }
  }
}

/**
 * 用量快照的写入器:带上锁定价目引用;同时只有一次写在进行,期间到的新快照覆盖旧的,
 * 写完再写最新的那份。失败只报告一次,不影响运行。
 */
function snapshotWriter(
  runId: string,
  pricing: RunPricing,
  save: (runId: string, cost: NonNullable<RunResult["cost"]>) => Promise<void>,
): (cost: unknown) => void {
  let pending: NonNullable<RunResult["cost"]> | undefined;
  let writing = false;
  let warned = false;
  const drain = async () => {
    writing = true;
    while (pending) {
      const next = pending;
      pending = undefined;
      await save(runId, next).catch((err) => {
        if (warned) return;
        warned = true;
        console.warn(
          `[owa] 用量快照写入失败(run=${runId}),之后的失败不再提示:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
    writing = false;
  };
  return (cost) => {
    pending = { ...(cost as NonNullable<RunResult["cost"]>), pricing };
    if (!writing) void drain();
  };
}
