// Webhook 结果投递(设计文稿 §7.3 三种取结果方式之一)。
//
// 语义:单次投递带少量即时重试;跨时间的重试由发件箱投递器(webhook-dispatcher.ts)负责。
// 绝不因为回调打不通而影响 run 的最终状态 —— 结果已经在库里,调用方随时能轮询兜底。

import { signWebhook } from "@/lib/modules/integration/domain/webhook-policy";
import { BrandedError } from "@/lib/shared";

export interface WebhookPayload {
  /** 投递标识(= taskId)。重发时不变,接收方据此去重。 */
  deliveryId?: string;
  event?: string;
  taskId: string;
  sessionId?: string;
  agentId?: string;
  /** 执行的智能体版本;缺省 = 草稿 */
  agentVersion?: number;
  status: string;
  structured?: unknown;
  summary?: string;
  error?: unknown;
  cost?: unknown;
}

export interface WebhookResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  error?: string;
}

/**
 * 实际发出请求的函数。生产用 adapters/guarded-http-sender.ts —— 它把地址校验接在
 * 连接自己的 DNS lookup 上;测试可注入假实现。
 *
 * 【为什么是必填】曾经的做法是"先解析检查、再 fetch(url)",两次解析之间存在
 * DNS rebinding 窗口。默认回落到裸 fetch 会让漏配的调用方悄悄回到那个漏洞上。
 */
export type WebhookSender = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean }>;

export interface WebhookOptions {
  send: WebhookSender;
  maxAttempts?: number;
  timeoutMs?: number;
  /** 重试前的等待;测试里可注入即时返回。 */
  sleep?: (ms: number) => Promise<void>;
  /** 签名密钥。给了就带 X-OWA-Timestamp / X-OWA-Signature 头。 */
  secret?: string;
  now?: () => number;
}

/** 目标地址被策略拒绝。属于配置问题,重试没有意义。 */
export class WebhookTargetRejected extends BrandedError {
  static readonly brand = Symbol.for("owa.error.WebhookTargetRejected");
  constructor(message: string) {
    super(message);
    this.name = "WebhookTargetRejected";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 5xx 与网络错误值得重试;4xx 是对方拒收,重试无意义。 */
function shouldRetry(status: number): boolean {
  return status >= 500 || status === 429;
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts: WebhookOptions,
): Promise<WebhookResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;

  // 签名覆盖的是【原样发出的这串字节】—— 必须先序列化一次,签名与发送共用
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (payload.deliveryId) headers["X-OWA-Delivery"] = payload.deliveryId;
  if (opts.secret) {
    const ts = Math.floor((opts.now ?? Date.now)() / 1000);
    headers["X-OWA-Timestamp"] = String(ts);
    headers["X-OWA-Signature"] = signWebhook(opts.secret, ts, body);
  }

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试独立超时,避免对方吊着连接把 worker 拖死
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // 发送器不跟随重定向:地址检查只对这一跳有效,一个 302 就能把请求转进内网
      const res = await opts.send(url, { method: "POST", headers, body, signal: ac.signal });
      lastStatus = res.status;
      if (res.ok) return { delivered: true, attempts: attempt, lastStatus: res.status };
      if (!shouldRetry(res.status)) {
        return { delivered: false, attempts: attempt, lastStatus: res.status };
      }
    } catch (err) {
      // 目标被策略拒绝是配置问题,重试只会再被拒一次
      if (err instanceof WebhookTargetRejected) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) await sleep(2 ** (attempt - 1) * 500);
  }

  return { delivered: false, attempts: maxAttempts, lastStatus, error: lastError };
}
