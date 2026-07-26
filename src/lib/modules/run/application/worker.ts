// Worker:从队列认领 run 并执行,租约续期证明存活,崩溃由孤儿回收兜底。
//
// 无本地状态 —— 认领靠 DB 乐观锁、事件走总线,故可以多进程/多实例水平扩容,
// 拆成独立进程只改部署不改码。

import { nextRunState } from "@/lib/modules/run/domain/state-machine";
import type { RunRepo } from "@/lib/modules/run/ports";
import type { RunOrchestrator } from "./orchestrator";

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
  now?: () => number;
}

const DEFAULTS = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  idleMs: 500,
  reclaimMs: 30_000,
  /** 30 分钟:够跑长任务,又不至于让卡死的运行永久占用 worker。 */
  maxDurationMs: 30 * 60_000,
};

export interface RunPayloadSource {
  /** 取出 run 待执行的 prompt。 */
  getPrompt(id: string): Promise<string | null>;
  /** 落终态结果,供轮询接口读取(内存 fake 可不实现)。只写传进来的字段。 */
  saveResult?(
    id: string,
    data: { structured?: unknown; cost?: unknown; error?: unknown },
    fence?: string,
  ): Promise<void>;
}

export class RunWorker {
  private running = false;
  private stopped = false;
  /** 连续轮询失败次数。健康检查据此判断 worker 是不是在空转假死。 */
  private consecutiveFailures = 0;
  private lastError?: string;

  /** 供 /api/health 暴露 —— 光探 DB 连通性看不出 worker 已经死循环了。 */
  health(): { running: boolean; consecutiveFailures: number; lastError?: string } {
    return {
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  private readonly opts: Required<Omit<WorkerOptions, "now">> & { now: () => number };

  constructor(
    private readonly repo: RunRepo & RunPayloadSource,
    private readonly orchestrator: RunOrchestrator,
    options: WorkerOptions = {},
  ) {
    this.opts = {
      leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      idleMs: options.idleMs ?? DEFAULTS.idleMs,
      reclaimMs: options.reclaimMs ?? DEFAULTS.reclaimMs,
      maxDurationMs: options.maxDurationMs ?? DEFAULTS.maxDurationMs,
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

    /**
     * 失租即中止。
     *
     * 续租失败曾经是 `.catch(() => {})` 静默丢弃 —— worker 不知道自己已经失去租约,
     * 照样跑到底。配合当时无守卫的 complete(),后果是同一任务被两个 worker 同时执行,
     * 且早已被判定为孤儿的那个还能覆写接手者的结果:重复扣费、重复下单、
     * 两个 SDK 进程并发写同一个工作目录。
     *
     * 现在续租返回 false(被回收或被接手)就立刻 abort 本轮,把损失止在这里。
     */
    let lostLease = false;
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

    try {
      const prompt = await this.repo.getPrompt(claimed.id);
      // 空提示词不能当正常输入跑:那会真的调一次模型、产出无意义回答、还标成功
      if (!prompt) throw new Error(`run ${claimed.id} 没有可执行的 prompt`);

      const result = await this.orchestrator.execute(
        { sessionId: claimed.sessionId, prompt, runId: claimed.id },
        abort.signal,
      );
      if (lostLease) return true; // 已被别人接手,本轮结果作废,不写库

      const finalState = nextRunState(
        "running",
        result.status === "success" ? "finishOk" : "finishErr",
      );
      // 先落结果再落终态:轮询方看到终态时结果必定已可读,避免"成功但取不到结果"的竞态
      await this.repo.saveResult?.(
        claimed.id,
        { structured: result.structured, cost: result.cost, error: result.error },
        fence,
      );
      await this.repo.complete(claimed.id, finalState, fence);
    } catch (err) {
      if (lostLease) return true;
      // 【只写 error】—— 不带 structured/cost 字段,免得把上一步已落库的成功结果抹掉
      await this.repo.saveResult?.(
        claimed.id,
        {
          error: {
            kind: "worker_error",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        fence,
      );
      await this.repo.complete(claimed.id, nextRunState("running", "finishErr"), fence);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
    return true;
  }

  /** 回收租约过期的孤儿任务(worker 崩溃后由存活的 worker 接手)。 */
  async reclaim(): Promise<number> {
    return this.repo.reclaimOrphans(this.opts.now());
  }

  /** 起后台轮询循环。调用 stop() 优雅退出。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    const loop = async () => {
      let lastReclaim = 0;
      while (!this.stopped) {
        try {
          const now = this.opts.now();
          if (now - lastReclaim > this.opts.reclaimMs) {
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
      this.running = false;
    };
    void loop();
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
    while (this.running) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // 睡眠不能超过剩余时间 —— 否则固定 100ms 的轮询粒度会让短超时实际等更久,
      // 关停时那点超出就是白白多占的部署窗口
      await new Promise((r) => setTimeout(r, Math.min(100, left)));
    }
    return !this.running;
  }
}
