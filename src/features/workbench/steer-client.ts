// 工作台追加消息的发送策略。
//
// 【只有明确的"没受理 / 没送达"才改作新消息】受理请求超时、网络错误、5xx 都不代表没受理 ——
// 这条可能已经入队,甚至之后才真正执行。此时自动改作新一轮,同一句话就会被执行两次。
// 所以:每条消息一个稳定 id,不确定时用同一 id 重试(服务端按 id 去重,同一 id 只入队一次,
// 没受理时会留下记录、迟到执行的同 id 请求不会再入队);重试仍拿不到定局,就如实告诉用户"未确认",
// 不自动重发。

export type SteerClientResult =
  /** 已交给智能体 */
  | { kind: "delivered"; id: string }
  /** 已受理,还没交给智能体;结局之后从事件流里来 */
  | { kind: "pending"; id: string }
  /** 明确没受理或没送达:可以作为新消息发送 */
  | { kind: "resend"; id: string }
  /** 多次重试仍不确定是否已受理:不能自动重发 */
  | { kind: "unconfirmed"; id: string }
  /** 请求本身有问题(参数、权限、会话不存在):重试无用,也不该重发 */
  | { kind: "invalid"; id: string; message: string };

export interface SendSteerOptions {
  fetchFn?: typeof fetch;
  /** 每次重试前的等待(毫秒);长度即重试次数 */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function sendSteer(
  req: { sessionId: string; runId: string; id: string; text: string },
  opts: SendSteerOptions = {},
): Promise<SteerClientResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const backoff = opts.backoffMs ?? [300, 1_000, 2_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { id } = req;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1] ?? 0);
    let res: Response;
    try {
      res = await fetchFn(`/api/sessions/${req.sessionId}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // id 每次都一样:服务端据此去重
        body: JSON.stringify({ runId: req.runId, id, text: req.text }),
      });
    } catch {
      continue; // 网络错误:请求可能已经到了服务端,只能用同一 id 再问
    }
    const body = (await res.json().catch(() => null)) as {
      outcome?: string;
      code?: string;
      error?: string;
    } | null;
    if (res.status === 200) return { kind: "delivered", id };
    if (res.status === 202 && body?.outcome === "pending") return { kind: "pending", id };
    if (res.status === 202) continue; // unknown:用同一 id 再问一次即可得到定局
    if (res.status === 409 && (body?.code === "not_accepting" || body?.code === "dropped")) {
      return { kind: "resend", id };
    }
    if (res.status >= 500) continue;
    return { kind: "invalid", id, message: body?.error ?? `追加失败(${res.status})` };
  }
  return { kind: "unconfirmed", id };
}
