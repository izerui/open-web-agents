// Worker:从队列认领 run 并执行,租约续期证明存活,崩溃由孤儿回收兜底。
//
// 无本地状态 —— 认领靠 DB 乐观锁、事件走总线,故可以多进程/多实例水平扩容,
// 拆成独立进程只改部署不改码。

import type { RunResult } from "@/lib/modules/agent-engine/ports";
import type { AgentConfig } from "@/lib/modules/agent/domain/config";
import { nextRunState } from "@/lib/modules/run/domain/state-machine";
import { type CancelSignal, type RunRepo, WORKER_LOST } from "@/lib/modules/run/ports";
import type { RunState } from "@/lib/shared";
import type { RunCommand, RunOrchestrator } from "./orchestrator";

export interface WorkerOptions {
  /** 租约时长;worker 崩溃后最多这么久任务被别人接手。 */
  leaseMs?: number;
  /** 续租间隔,必须显著小于 leaseMs。 */
  heartbeatMs?: number;
  /** 空队列时的轮询间隔。 */
  idleMs?: number;
  /** 孤儿回收扫描间隔。 */
  reclaimMs?: number;
  /**
   * 单次运行的墙钟上限,到点中断。
   *
   * 为什么必须有:maxTurns 只限轮次,拦不住"卡在一次网络调用上"的情况
   * (实测把 base_url 指到不可达网关,运行会一直挂着 —— 心跳持续续租,
   * worker 被永久占住,任务也永远不落终态)。
   */
  maxDurationMs?: number;
  /**
   * 本进程同时执行的运行数。
   *
   * 曾经是串行的一个:agent 一轮常要几分钟,人工审批还能挂 10 分钟,
   * 等审批的那段时间整个进程什么都不干,平台并发度就等于进程数。
   * 同一会话仍然串行(由 claimNext 保证),这里只放开不同会话之间的并行。
   */
  concurrency?: number;
  now?: () => number;
}

/** 运行落了终态之后的通知。数据库已是终态,发布事件的一方以它为准。 */
export interface RunFinalized {
  runId: string;
  sessionId: string;
  state: RunState;
  result: RunResult;
}

const DEFAULTS = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  idleMs: 500,
  reclaimMs: 30_000,
  /** 30 分钟:够跑长任务,又不至于让卡死的运行永久占用 worker。 */
  maxDurationMs: 30 * 60_000,
  concurrency: 4,
};

export interface RunPayloadSource {
  /** 取出 run 待执行的载荷:输入、入队时的配置快照、加密的请求级覆盖。 */
  getPayload(
    id: string,
  ): Promise<{ prompt: string; agentConfig?: unknown; overrideEnc?: string } | null>;
  /**
   * 补记花费,只在该运行还没有花费记录时写入,不需要租约令牌。
   * 被取消的运行已经不归本 worker 写结果,但它花掉的钱仍要入账 —— 否则在运行快结束时
   * 点取消,这一轮的花费就不计入额度。
   */
  recordCost?(id: string, cost: unknown): Promise<void>;
  /** 落终态结果,供轮询接口读取(内存 fake 可不实现)。只写传进来的字段。 */
  saveResult?(
    id: string,
    data: {
      finalText?: string;
      structured?: unknown;
      salvaged?: boolean;
      cost?: unknown;
      error?: unknown;
    },
    fence?: string,
  ): Promise<void>;
}

export interface WorkerHooks {
  /**
   * 运行【已经落了终态】之后调用(含孤儿回收判定的失败)。
   *
   * 终态事件曾经由编排层在 execute 里发布 —— 早于 worker 落库,而且编排层不知道
   * 本轮是否已被取消或失租:SSE 先报 failed、库里却是 cancelled;失租作废的运行
   * 照样发结果。现在以数据库为准:只有真正写入终态的一方才通知。
   */
  onFinalized?: (info: RunFinalized) => void | Promise<void>;
  /** 解密请求级覆盖。解不开必须抛错 —— 不能悄悄回落到平台凭证。 */
  decodeOverride?: (enc: string) => RunCommand["override"];
  /** 取消通知:收到就立即中止对应的在途运行,不必等下一次续租心跳。 */
  cancelSignal?: CancelSignal;
}

export class RunWorker {
  /** 正在运行的轮询槽位数。 */
  private activeLoops = 0;
  private stopped = false;
  /** 在途运行的中止器 —— 关停宽限期到点时用来主动收尾。 */
  private readonly inFlight = new Set<AbortController>();
  /** 在途运行 → 让它按"已失租"收场的函数。取消通知按 runId 找到它。 */
  private readonly cancelByRun = new Map<string, () => void>();
  private unsubscribeCancel: (() => void) | null = null;
  /** 连续轮询失败次数。健康检查据此判断 worker 是不是在空转假死。 */
  private consecutiveFailures = 0;
  private lastError?: string;

  /** 供 /api/health 暴露 —— 光探 DB 连通性看不出 worker 已经死循环了。 */
  health(): { running: boolean; consecutiveFailures: number; lastError?: string } {
    return {
      running: this.activeLoops > 0,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  private readonly opts: Required<Omit<WorkerOptions, "now">> & { now: () => number };

  constructor(
    private readonly repo: RunRepo & RunPayloadSource,
    private readonly orchestrator: RunOrchestrator,
    options: WorkerOptions = {},
    private readonly hooks: WorkerHooks = {},
  ) {
    this.opts = {
      leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      idleMs: options.idleMs ?? DEFAULTS.idleMs,
      reclaimMs: options.reclaimMs ?? DEFAULTS.reclaimMs,
      maxDurationMs: options.maxDurationMs ?? DEFAULTS.maxDurationMs,
      concurrency: Math.max(1, Math.floor(options.concurrency ?? DEFAULTS.concurrency)),
      now: options.now ?? (() => Date.now()),
    };
  }

  /**
   * 认领并执行一个 run。返回是否真的处理了任务(供轮询循环决定要不要 sleep)。
   * 单步可测 —— 测试直接调它,不用起后台循环。
   */
  async tick(): Promise<boolean> {
    const now = this.opts.now();
    const claimed = await this.repo.claimNext(this.opts.leaseMs, now);
    if (!claimed) return false;

    // 认领即 pending→running,状态机校验合法性
    nextRunState("pending", "claim");

    const fence = claimed.fence;
    const abort = new AbortController();
    this.inFlight.add(abort);

    /**
     * 失租即中止。
     *
     * 续租失败曾经是 `.catch(() => {})` 静默丢弃 —— worker 不知道自己已经失去租约,
     * 照样跑到底。配合当时无守卫的 complete(),后果是同一任务被两个 worker 同时执行,
     * 且早已被判定为孤儿的那个还能覆写接手者的结果:重复扣费、重复下单、
     * 两个 SDK 进程并发写同一个工作目录。
     *
     * 现在续租返回 false(被取消或被判定为孤儿)就立刻 abort 本轮,把损失止在这里。
     */
    let lostLease = false;
    // 收到取消通知:与续租返回 false 同等处理(数据库里已经是 cancelled,结果本就写不进去)
    this.cancelByRun.set(claimed.id, () => {
      lostLease = true;
      abort.abort();
    });
    const heartbeat = setInterval(() => {
      void this.repo
        .touch(claimed.id, this.opts.now() + this.opts.leaseMs, fence)
        .then((ok) => {
          if (!ok) {
            lostLease = true;
            abort.abort();
          }
        })
        // 抛错只是这一次没续上,下一拍还有机会;真正失租由上面的 ok=false 判定
        .catch(() => {});
    }, this.opts.heartbeatMs);

    // 墙钟超时:到点强制中断,保证任务必定落终态、worker 必定被释放。
    // 上限钳到 setTimeout 能表达的范围 —— 超过 2^31-1ms 会被 Node 折成 1ms,
    // 于是"配 30 天等于基本不限时"的意图反转成"每个运行认领后立刻中止"。
    const timeout = setTimeout(() => abort.abort(), Math.min(this.opts.maxDurationMs, 2 ** 31 - 1));

    let result: RunResult;
    try {
      const payload = await this.repo.getPayload(claimed.id);
      // 空提示词不能当正常输入跑:那会真的调一次模型、产出无意义回答、还标成功
      if (!payload?.prompt) throw new Error(`run ${claimed.id} 没有可执行的 prompt`);
      const override =
        payload.overrideEnc && this.hooks.decodeOverride
          ? this.hooks.decodeOverride(payload.overrideEnc)
          : undefined;

      result = await this.orchestrator.execute(
        {
          sessionId: claimed.sessionId,
          prompt: payload.prompt,
          runId: claimed.id,
          override,
          agentConfig: payload.agentConfig as AgentConfig | undefined,
        },
        abort.signal,
      );
    } catch (err) {
      result = {
        status: "failed",
        error: {
          kind: "worker_error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    try {
      // 已被取消或判为孤儿:本轮结果作废,不写结果、不通知 —— 终态由取消方/回收方负责。
      // 但花费照记:钱已经花出去了
      if (lostLease) {
        if (result.cost) await this.repo.recordCost?.(claimed.id, result.cost).catch(() => {});
        return true;
      }

      const finalState = nextRunState(
        "running",
        result.status === "success" ? "finishOk" : "finishErr",
      );
      // 先落结果再落终态:轮询方看到终态时结果必定已可读,避免"成功但取不到结果"的竞态
      await this.repo.saveResult?.(
        claimed.id,
        {
          finalText: result.summary,
          structured: result.structured,
          salvaged: result.salvagedFromText === true,
          cost: result.cost,
          error: result.error,
        },
        fence,
      );
      const written = await this.repo.complete(claimed.id, finalState, fence);
      // 没写进去 = 这一刻恰好被取消/回收了(上面带令牌的 saveResult 也同样没写进去),
      // 不归本 worker 通知 —— 但花费要补记
      if (!written && result.cost) {
        await this.repo.recordCost?.(claimed.id, result.cost).catch(() => {});
      }
      if (written) {
        await this.notifyFinalized({
          runId: claimed.id,
          sessionId: claimed.sessionId,
          state: finalState,
          result,
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.inFlight.delete(abort);
      this.cancelByRun.delete(claimed.id);
    }
    return true;
  }

  private async notifyFinalized(info: RunFinalized): Promise<void> {
    try {
      await this.hooks.onFinalized?.(info);
    } catch (err) {
      // 通知失败不影响终态 —— 结果已在库里,轮询与 SSE 的数据库兜底都能拿到
      console.warn(
        `[owa][worker] 终态通知失败(run=${info.runId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 回收租约过期的孤儿任务:判为失败(至多一次),并通知等待方。
   * 没有这一步通知,SSE 与阻塞请求会一直等一个永远不会来的终态事件。
   */
  async reclaim(): Promise<number> {
    const reclaimed = await this.repo.reclaimOrphans(this.opts.now());
    for (const r of reclaimed) {
      await this.notifyFinalized({
        runId: r.id,
        sessionId: r.sessionId,
        state: "failed",
        result: {
          status: "failed",
          error: { kind: WORKER_LOST, message: "执行该运行的 worker 失去响应,运行已中止" },
        },
      });
    }
    return reclaimed.length;
  }

  /** 起后台轮询循环(concurrency 个槽位)。调用 stop() 优雅退出。 */
  start(): void {
    if (this.activeLoops > 0) return;
    this.stopped = false;
    this.unsubscribeCancel ??=
      this.hooks.cancelSignal?.subscribe((runId) => this.cancelByRun.get(runId)?.()) ?? null;
    for (let slot = 0; slot < this.opts.concurrency; slot++) {
      this.activeLoops++;
      void this.loop(slot === 0);
    }
  }

  private async loop(reclaimer: boolean): Promise<void> {
    let lastReclaim = 0;
    try {
      while (!this.stopped) {
        try {
          const now = this.opts.now();
          // 孤儿回收只需要一个槽位做,别让 N 个槽位一起扫表
          if (reclaimer && now - lastReclaim > this.opts.reclaimMs) {
            lastReclaim = now;
            await this.reclaim();
          }
          const did = await this.tick();
          if (!did) await new Promise((r) => setTimeout(r, this.opts.idleMs));
          this.consecutiveFailures = 0;
          this.lastError = undefined;
        } catch (err) {
          // 单次失败不能杀死 worker 循环 —— 但也【不能一声不吭】。
          //
          // 这里曾经是裸 catch 无日志:DB 凭证错、runs 表缺失、连接池耗尽这些情况下
          // claimNext 每次迭代都抛,循环就以 500ms 空转,零输出零指标,队列无界堆积,
          // 而 /api/health 仍然报 ready(它探的是 SELECT 1,从不探 worker)。
          // 运维侧完全没有"worker 假死"的信号。
          this.consecutiveFailures++;
          this.lastError = err instanceof Error ? err.message : String(err);
          // 头几次可能只是抖动;连续失败才是真出事了,且要避免日志刷屏
          if (this.consecutiveFailures === 3 || this.consecutiveFailures % 60 === 0) {
            console.error(
              `[owa][worker] 连续 ${this.consecutiveFailures} 次轮询失败,队列可能正在堆积:${this.lastError}`,
            );
          }
          // 持续失败时退避,别拿满速重试去捶一个已经不健康的依赖
          const backoff = Math.min(
            this.opts.idleMs * 2 ** Math.min(this.consecutiveFailures, 6),
            30_000,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    } finally {
      this.activeLoops--;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * 等在途任务收尾。返回是否干净排空(false = 超时,仍有任务在跑)。
   *
   * 【stop() 本身不等任何东西】—— 它只是让轮询循环下一拍别再认领。真正在跑的
   * tick() 可能还要几分钟。之前的关停是 stop() 之后固定 setTimeout 5 秒就
   * process.exit(0),从不追踪在途 promise:而 maxDurationMs 默认 30 分钟,
   * 也就是说【几乎所有真实运行】都会被中途砍掉,行留在 running 直到租约过期,
   * 然后被别的 worker 从头重跑 —— 正是那段注释声称要避免的「重复执行副作用」。
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeLoops > 0) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // 睡眠不能超过剩余时间 —— 否则固定 100ms 的轮询粒度会让短超时实际等更久,
      // 关停时那点超出就是白白多占的部署窗口
      await new Promise((r) => setTimeout(r, Math.min(100, left)));
    }
    return this.activeLoops === 0;
  }

  /**
   * 中止全部在途运行,让它们走正常收尾路径落 failed 终态。
   *
   * 宽限期到了还没跑完时用:直接退出进程的话,这些运行要等租约过期才被回收,
   * 而在至多一次语义下回收就是判失败 —— 结局一样,只是白等一个租约周期,
   * 期间界面一直显示"运行中"。主动中止能让它们立刻有结论。
   */
  abortInFlight(): number {
    for (const a of this.inFlight) a.abort();
    return this.inFlight.size;
  }
}
