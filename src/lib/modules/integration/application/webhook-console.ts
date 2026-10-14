// Webhook 控制台:投递记录、测试投递、手动重发 —— 给集成方排查对接问题用。
//
// 以前回调发了什么、对方回了什么、为什么失败,只在服务端日志里;
// 集成方看不到,也没法自己重发或先发一条测试确认验签逻辑。

import { randomUUID } from "node:crypto";
import { recordBestEffort } from "@/lib/modules/integration/application/best-effort";
import {
  type WebhookPayload,
  type WebhookResult,
  WebhookTargetRejected,
} from "@/lib/modules/integration/application/webhook";
import type { WebhookTarget } from "@/lib/modules/integration/application/webhook-dispatcher";
import { redactWebhookUrl } from "@/lib/modules/integration/domain/webhook-policy";
import type {
  WebhookDelivery,
  WebhookDeliveryLog,
  WebhookOutbox,
} from "@/lib/modules/integration/ports";

export interface WebhookConsoleDeps {
  /** 该智能体当前的投递目标(地址 + 所有者签名密钥);没配回调返回 null */
  targetOfAgent(agentId: string): Promise<WebhookTarget | null>;
  /** 单次投递(测试投递不做即时重试) */
  deliver(url: string, payload: WebhookPayload, secret?: string): Promise<WebhookResult>;
  log: WebhookDeliveryLog;
  outbox: Pick<WebhookOutbox, "requeueWebhook">;
  now?: () => number;
  /** 投递记录写入的等待上限(默认 2s);测试里调小 */
  recordTimeoutMs?: number;
  onRecordError?: (err: unknown) => void;
}

export type TestResult = { configured: false } | { configured: true; delivery: WebhookDelivery };

export class WebhookConsole {
  constructor(private readonly deps: WebhookConsoleDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  list(agentId: string, q: { cursor?: string; limit?: number }) {
    return this.deps.log.listByAgent(agentId, q);
  }

  /**
   * 向当前回调地址发一条测试事件(event = "webhook.test"),带与正式回调相同的签名头,
   * 同步返回结果并记入投递记录。集成方据此确认地址可达、验签逻辑正确。
   */
  async sendTest(agentId: string): Promise<TestResult> {
    const target = await this.deps.targetOfAgent(agentId);
    if (!target) return { configured: false };
    const id = randomUUID();
    const payload: WebhookPayload = {
      deliveryId: `test-${id}`,
      event: "webhook.test",
      taskId: `test-${id}`,
      agentId,
      status: "success",
      summary: "这是一条测试回调,用于确认地址可达与签名校验。",
    };
    const started = this.now();
    let r: WebhookResult;
    try {
      r = await this.deps.deliver(target.url, payload, target.secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      r = {
        delivered: false,
        attempts: 1,
        error: err instanceof WebhookTargetRejected ? `目标被拒:${msg}` : msg,
      };
    }
    const delivery: WebhookDelivery = {
      id,
      agentId,
      trigger: "test",
      url: redactWebhookUrl(target.url),
      httpStatus: r.lastStatus,
      ok: r.delivered,
      error: r.error,
      durationMs: this.now() - started,
      signed: Boolean(target.secret),
      at: started,
    };
    // 尽力记录、有界等待:对方已经收到测试事件,记录写不进去也要如实返回投递结果
    await recordBestEffort(() => this.deps.log.record(delivery), {
      timeoutMs: this.deps.recordTimeoutMs,
      onError: this.deps.onRecordError,
    });
    return { configured: true, delivery };
  }

  /** 手动重发:放回发件箱由投递器按正常流程发出。返回是否已入队(还在投递中则 false)。 */
  redeliver(runId: string): Promise<boolean> {
    return this.deps.outbox.requeueWebhook(runId, this.now());
  }
}
