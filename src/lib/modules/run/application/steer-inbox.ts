// 运行中途追加消息的收件箱(worker 侧):把 SteerChannel 适配成引擎看到的 SteerInbox。
//
// 【送达只在这里确认】引擎从 next() 取到一条、交给模型输入之前调 delivered() —— 记为已送达。
// close() 之后的 next() 先等关闭完成、把关闭时取走的那批交出去,才返回 null:
// 关闭发生在第一条 result 到达时,模型那时仍在读输入,这批消息照样能交给它。
// abandon() 在运行结束、模型不再读输入时调用:还没交出去的一律记为未送达。
//
// 对通道的每次调用都有上限(通道实现自带命令超时);通道出错只影响追加消息,不影响运行本身。

import type { SteerChannel } from "@/lib/modules/run/ports";
import type { SteerInbox, SteerMessage } from "@/lib/shared";

export interface SteerInboxOptions {
  /** 没收到通知时多久主动查一次(通知可能漏)。 */
  pollMs?: number;
  /** 结局写失败等异常的去向。 */
  onError?: (what: string, err: unknown) => void;
}

export class ChannelSteerInbox implements SteerInbox {
  private readonly buffer: SteerMessage[] = [];
  private closing: Promise<void> | null = null;
  private abandoned = false;
  private wake: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  private readonly pollMs: number;
  private readonly onError: (what: string, err: unknown) => void;

  private constructor(
    private readonly channel: SteerChannel,
    private readonly runId: string,
    opts: SteerInboxOptions,
  ) {
    this.pollMs = opts.pollMs ?? 1_000;
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

  async next(): Promise<SteerMessage | null> {
    for (;;) {
      // 运行已经结束:模型不再读输入,剩下的由 abandon 记为未送达,这里一条也不再交出
      if (this.abandoned) return null;
      const head = this.buffer.shift();
      if (head) return head;
      if (this.closing) {
        // 关闭时取走的那批要先交出去,才算"取完"
        await this.closing;
        if (this.abandoned) return null;
        return this.buffer.shift() ?? null;
      }
      let got: SteerMessage[] = [];
      try {
        got = await this.channel.take(this.runId);
      } catch (err) {
        this.onError("读取追加消息失败", err);
      }
      if (this.abandoned) {
        // 取回来时运行已经结束:模型不会再读了
        await this.settleAll(got, "dropped");
        return null;
      }
      if (got.length > 0) {
        this.buffer.push(...got);
        continue;
      }
      if (this.closing) continue;
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
    try {
      await this.channel.settle(this.runId, m.id, "delivered");
    } catch (err) {
      this.onError("记录送达失败", err);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.channel
        .close(this.runId)
        .then((rest) => {
          this.buffer.push(...rest);
        })
        .catch((err) => {
          // 关不掉(通道不可用):本地不再取,之后受理的消息等不到送达,接口按"待定"答复
          this.onError("关闭追加消息失败", err);
        });
      this.wake?.();
    }
    return this.closing;
  }

  async abandon(): Promise<SteerMessage[]> {
    this.abandoned = true;
    await this.close();
    this.unsubscribe();
    const left = this.buffer.splice(0);
    await this.settleAll(left, "dropped");
    this.wake?.();
    return left;
  }

  private async settleAll(ms: SteerMessage[], outcome: "delivered" | "dropped") {
    for (const m of ms) {
      try {
        await this.channel.settle(this.runId, m.id, outcome);
      } catch (err) {
        this.onError("记录结局失败", err);
      }
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
