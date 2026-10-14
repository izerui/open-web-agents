// 运行中途追加消息的收件箱(worker 侧):把 SteerChannel 适配成引擎看到的 SteerInbox。
//
// 【送达只在这里确认】引擎从 next() 取到一条、交给模型输入之前调 delivered() —— 先在本地记下
// "已交出",再写通道里的结局(写结局时才从队列删除)。
// close() 之后的 next() 先等关闭完成、把那时还没结局的交出去,才返回 null:
// 关闭发生在第一条 result 到达时,模型那时仍在读输入,这批消息照样能交给它。
// abandon() 在运行结束、模型不再读输入时调用:再从通道读一遍还没结局的 ——
// 本地记着已交出的补记 delivered,其余记 dropped。通道里的读取都是只读不删,
// 所以哪一次读取的响应丢了,都不会让已受理的消息失去结局(只要收尾时通道可用)。

import type { SteerChannel } from "@/lib/modules/run/ports";
import type { SteerInbox, SteerMessage } from "@/lib/shared";

export interface SteerInboxOptions {
  /** 没收到通知时多久主动查一次(通知可能漏)。 */
  pollMs?: number;
  /** 收尾时读取 / 写结局失败的重试次数。 */
  settleAttempts?: number;
  onError?: (what: string, err: unknown) => void;
}

export class ChannelSteerInbox implements SteerInbox {
  private readonly buffer: SteerMessage[] = [];
  /**
   * 已从 next() 交给引擎的 id(通道里的结局可能还没写成功)。
   * 在 next() 返回的那一刻就记下,而不是等 delivered():两者之间若恰好关闭输入,
   * 关闭时会再读到这条 —— 不在这里记着,就会被交给模型第二次。
   */
  private readonly handed = new Set<string>();
  private closing: Promise<void> | null = null;
  private abandoned = false;
  private wake: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  private readonly pollMs: number;
  private readonly attempts: number;
  private readonly onError: (what: string, err: unknown) => void;

  private constructor(
    private readonly channel: SteerChannel,
    private readonly runId: string,
    opts: SteerInboxOptions,
  ) {
    this.pollMs = opts.pollMs ?? 1_000;
    this.attempts = opts.settleAttempts ?? 3;
    this.onError =
      opts.onError ??
      ((what, err) => console.warn(`[owa][steer] ${what}(run=${runId}):`, errText(err)));
    this.unsubscribe = channel.onOffer(runId, () => this.wake?.());
  }

  /** 开始受理。开不了(通道不可用)返回 null —— 这一轮就不接受追加,运行照常。 */
  static async open(
    channel: SteerChannel,
    runId: string,
    opts: SteerInboxOptions = {},
  ): Promise<ChannelSteerInbox | null> {
    try {
      await channel.open(runId);
    } catch (err) {
      (opts.onError ?? (() => {}))("开启追加消息失败,本轮不接受追加", err);
      return null;
    }
    return new ChannelSteerInbox(channel, runId, opts);
  }

  /** 把读到的、还没交出也没在缓冲里的,按顺序放进缓冲 */
  private absorb(ms: SteerMessage[]) {
    for (const m of ms) {
      if (this.handed.has(m.id) || this.buffer.some((b) => b.id === m.id)) continue;
      this.buffer.push(m);
    }
  }

  async next(): Promise<SteerMessage | null> {
    const m = await this.nextUnhanded();
    if (m) this.handed.add(m.id);
    return m;
  }

  private async nextUnhanded(): Promise<SteerMessage | null> {
    for (;;) {
      // 运行已经结束:模型不再读输入,剩下的由 abandon 记为未送达,这里一条也不再交出
      if (this.abandoned) return null;
      const head = this.buffer.shift();
      if (head) return head;
      if (this.closing) {
        // 关闭时读到的那批要先交出去,才算"取完"
        await this.closing;
        if (this.abandoned) return null;
        return this.buffer.shift() ?? null;
      }
      try {
        this.absorb(await this.channel.take(this.runId));
      } catch (err) {
        // 只读不删:这次没读到,消息仍在通道里,下次再读
        this.onError("读取追加消息失败", err);
      }
      if (this.buffer.length > 0 || this.closing || this.abandoned) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, this.pollMs);
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.wake = done;
      });
      this.wake = null;
    }
  }

  async delivered(m: SteerMessage): Promise<void> {
    // 本地已在 next() 记下"已交出":这里写结局失败时,收尾据此补记 delivered,而不是误判成 dropped
    try {
      await this.channel.settle(this.runId, m.id, "delivered");
    } catch (err) {
      this.onError("记录送达失败(收尾时补记)", err);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.channel
        .close(this.runId)
        .then((rest) => this.absorb(rest))
        .catch((err) => {
          // 这次读不到关闭时剩下的:它们仍在通道里,收尾时记为未送达(调用方据此重发)
          this.onError("关闭追加消息失败", err);
        });
      this.wake?.();
    }
    return this.closing;
  }

  async abandon(): Promise<SteerMessage[]> {
    this.abandoned = true;
    this.wake?.();
    await this.close();
    this.unsubscribe();

    // 再读一遍通道里还没结局的 —— 之前任何一次读取的响应丢了,它们都还在
    let rest: SteerMessage[] | null = null;
    for (let i = 0; i < this.attempts && rest === null; i++) {
      try {
        rest = await this.channel.close(this.runId);
      } catch (err) {
        this.onError(`收尾时读取追加消息失败(第 ${i + 1} 次)`, err);
      }
    }
    const left = [...this.buffer.splice(0)];
    for (const m of rest ?? []) if (!left.some((x) => x.id === m.id)) left.push(m);

    const dropped: SteerMessage[] = [];
    for (const m of left) {
      const outcome = this.handed.has(m.id) ? "delivered" : "dropped";
      if (outcome === "dropped") dropped.push(m);
      await this.settleWithRetry(m.id, outcome);
    }
    return dropped;
  }

  private async settleWithRetry(id: string, outcome: "delivered" | "dropped") {
    for (let i = 0; i < this.attempts; i++) {
      try {
        await this.channel.settle(this.runId, id, outcome);
        return;
      } catch (err) {
        this.onError(`记录结局失败(第 ${i + 1} 次)`, err);
      }
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
