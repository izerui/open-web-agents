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
  now?: () => number;
}

const DEFAULTS = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  idleMs: 500,
  reclaimMs: 30_000,
};

export interface RunPayloadSource {
  /** 取出 run 待执行的 prompt。 */
  getPrompt(id: string): Promise<string | null>;
  /** 落终态结果,供轮询接口读取(内存 fake 可不实现)。 */
  saveResult?(
    id: string,
    data: { structured?: unknown; cost?: unknown; error?: unknown },
  ): Promise<void>;
}

export class RunWorker {
  private running = false;
  private stopped = false;
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

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void this.repo.touch(claimed.id, this.opts.now() + this.opts.leaseMs).catch(() => {});
    }, this.opts.heartbeatMs);

    try {
      const prompt = (await this.repo.getPrompt(claimed.id)) ?? "";
      const result = await this.orchestrator.execute(
        { sessionId: claimed.sessionId, prompt, runId: claimed.id },
        abort.signal,
      );
      const finalState = nextRunState(
        "running",
        result.status === "success" ? "finishOk" : "finishErr",
      );
      // 先落结果再落终态:轮询方看到终态时结果必定已可读,避免"成功但取不到结果"的竞态
      await this.repo.saveResult?.(claimed.id, {
        structured: result.structured,
        cost: result.cost,
        error: result.error,
      });
      await this.repo.complete(claimed.id, finalState);
    } catch (err) {
      await this.repo.saveResult?.(claimed.id, {
        error: { kind: "worker_error", message: err instanceof Error ? err.message : String(err) },
      });
      await this.repo.complete(claimed.id, nextRunState("running", "finishErr"));
    } finally {
      clearInterval(heartbeat);
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
        } catch {
          // 单次失败不能杀死 worker 循环
          await new Promise((r) => setTimeout(r, this.opts.idleMs));
        }
      }
      this.running = false;
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
  }
}
