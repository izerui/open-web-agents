// Webhook 结果投递(设计文稿 §7.3 三种取结果方式之一)。
//
// 语义:尽力投递,失败重试有限次,绝不因为回调打不通而影响 run 的最终状态 ——
// 结果已经在库里,调用方随时能轮询兜底。

export interface WebhookPayload {
  taskId: string;
  status: string;
  structured?: unknown;
  summary?: string;
  error?: unknown;
}

export interface WebhookResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  error?: string;
}

export interface WebhookOptions {
  maxAttempts?: number;
  timeoutMs?: number;
  /** 重试前的等待;测试里可注入即时返回。 */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 5xx 与网络错误值得重试;4xx 是对方拒收,重试无意义。 */
function shouldRetry(status: number): boolean {
  return status >= 500 || status === 429;
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts: WebhookOptions = {},
): Promise<WebhookResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 每次尝试独立超时,避免对方吊着连接把 worker 拖死
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      lastStatus = res.status;
      if (res.ok) return { delivered: true, attempts: attempt, lastStatus: res.status };
      if (!shouldRetry(res.status)) {
        return { delivered: false, attempts: attempt, lastStatus: res.status };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) await sleep(2 ** (attempt - 1) * 500);
  }

  return { delivered: false, attempts: maxAttempts, lastStatus, error: lastError };
}
