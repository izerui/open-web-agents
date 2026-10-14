// 回调投递器:从发件箱取到期的回调,签名后投递,失败按退避表重试。
//
// 投递是【至少一次】:投递成功但标记 delivered 之前进程崩了,租约过期后会再发一次。
// 接收方按 X-OWA-Delivery(= taskId)去重。

import { randomUUID } from "node:crypto";
import { recordBestEffort } from "@/lib/modules/integration/application/best-effort";
import type { WebhookPayload, WebhookResult } from "@/lib/modules/integration/application/webhook";
import { WebhookTargetRejected } from "@/lib/modules/integration/application/webhook";
import { nextWebhookDelay } from "@/lib/modules/integration/domain/webhook-policy";
import { redactWebhookUrl } from "@/lib/modules/integration/domain/webhook-policy";
import type { WebhookDelivery, WebhookOutbox } from "@/lib/modules/integration/ports";

/** 投递目标。null = 该智能体没配回调,标 skipped。 */
export interface WebhookTarget {
  /** 投递记录按它归属(所有者与管理员可见) */
  agentId: string;
  url: string;
  /** 智能体所有者的签名密钥;没配置则不签名。 */
  secret?: string;
}

export interface DispatcherDeps {
  outbox: WebhookOutbox;
  /** 解析该运行的投递目标。签名密钥配置了却解不开时必须抛错 —— 不能悄悄发不签名的请求。 */
  loadTarget(sessionId: string): Promise<WebhookTarget | null>;
  /** 从数据库读终态结果拼载荷 —— 回调内容与 /result 接口同源。 */
  loadPayload(runId: string, sessionId: string): Promise<WebhookPayload | null>;
  deliver(url: string, payload: WebhookPayload, secret?: string): Promise<WebhookResult>;
  /**
   * 记下这次投递(供集成方排查)。尽力而为:写失败或超时只记日志,不影响投递状态;
   * 每次写入有等待上限,数据库不返回时不能把投递器拖住。
   */
  recordDelivery?(d: WebhookDelivery): Promise<void>;
  now?: () => number;
}

export interface DispatcherOptions {
  /** 单次投递的认领租约。须大于一次投递的最长耗时(含即时重试)。 */
  leaseMs?: number;
  pollMs?: number;
  /** 每轮最多处理几条,避免一轮占太久。 */
  batch?: number;
}

export class WebhookDispatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly batch: number;

  constructor(
    private readonly deps: DispatcherDeps,
    opts: DispatcherOptions = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.leaseMs = opts.leaseMs ?? 2 * 60_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.batch = opts.batch ?? 20;
  }

  /** 处理一批到期回调,返回处理条数。单步可测。 */
  async runOnce(): Promise<number> {
    let n = 0;
    while (n < this.batch) {
      const job = await this.deps.outbox.claimWebhook(this.now(), this.leaseMs);
      if (!job) break;
      n++;
      await this.handle(job);
    }
    return n;
  }

  private async handle(job: { runId: string; sessionId: string; attempts: number; lease: string }) {
    const { outbox } = this.deps;
    /*
     * 写回本次投递的结局,带上认领令牌:租约过期被别人接手、或期间被手动重发,
     * 这次的结果就是过期的,丢弃 —— 不能覆盖别人的结局,更不能把已受理的重发吞掉。
     */
    const mark = async (
      state: "delivered" | "failed" | "skipped" | "pending",
      nextAt?: number,
    ): Promise<void> => {
      if (!(await outbox.markWebhook(job.runId, job.lease, state, nextAt))) {
        console.warn(
          `[owa][webhook] 投递结果已过期,丢弃(run=${job.runId},结局=${state}):租约已被接手或已被手动重发`,
        );
      }
    };
    let target: WebhookTarget | null;
    try {
      target = await this.deps.loadTarget(job.sessionId);
    } catch (err) {
      console.warn(`[owa][webhook] 无法准备投递(run=${job.runId}):${errText(err)}`);
      await mark("failed");
      return;
    }
    if (!target) {
      await mark("skipped");
      return;
    }

    const payload = await this.deps.loadPayload(job.runId, job.sessionId);
    if (!payload) {
      await mark("skipped");
      return;
    }

    let result: WebhookResult;
    const started = this.now();
    const record = (r: WebhookResult) =>
      this.record({
        id: randomUUID(),
        agentId: target.agentId,
        runId: job.runId,
        trigger: "auto",
        attempt: job.attempts,
        url: redactWebhookUrl(target.url),
        httpStatus: r.lastStatus,
        ok: r.delivered,
        error: r.error,
        durationMs: this.now() - started,
        signed: Boolean(target.secret),
        at: started,
      });
    try {
      result = await this.deps.deliver(target.url, payload, target.secret);
    } catch (err) {
      if (err instanceof WebhookTargetRejected) {
        console.warn(`[owa][webhook] 目标被拒(run=${job.runId}):${err.message}`);
        await record({ delivered: false, attempts: 1, error: `目标被拒:${err.message}` });
        await mark("failed");
        return;
      }
      result = { delivered: false, attempts: 1, error: errText(err) };
    }
    await record(result);

    if (result.delivered) {
      await mark("delivered");
      return;
    }
    // 4xx(除 408/429)是对方明确拒收,重试没有意义
    const s = result.lastStatus;
    const permanent = s !== undefined && s < 500 && s !== 408 && s !== 429;
    const delay = permanent ? null : nextWebhookDelay(job.attempts);
    if (delay === null) {
      const reason = `${s ?? ""} ${result.error ?? ""}`.trim();
      console.warn(`[owa][webhook] 放弃投递(run=${job.runId},第 ${job.attempts} 次):${reason}`);
      await mark("failed");
    } else {
      await mark("pending", this.now() + delay);
    }
  }

  private async record(d: WebhookDelivery): Promise<void> {
    const write = this.deps.recordDelivery;
    if (!write) return;
    await recordBestEffort(() => write(d), {
      onError: (err) =>
        console.warn(`[owa][webhook] 投递记录写入失败(run=${d.runId}):${errText(err)}`),
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (err) {
        console.warn(`[owa][webhook] 投递轮询失败:${errText(err)}`);
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => void tick(), this.pollMs);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
