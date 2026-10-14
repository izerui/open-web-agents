// 取消通知的 Redis pub/sub 实现。见 run/ports.ts 的 CancelSignal。

import type { CancelSignal } from "@/lib/modules/run/ports";
import Redis from "ioredis";

const CHANNEL = "owa:run:cancel";
const PUBLISH_TIMEOUT_MS = 2_000;

export class RedisCancelSignal implements CancelSignal {
  private readonly pub: Redis;
  private sub: Redis | null = null;
  private readonly listeners = new Set<(runId: string) => void>();

  constructor(private readonly redisUrl: string) {
    // 发不出去就算了(心跳兜底),不能让取消接口卡在离线队列里
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.pub.on("error", () => {});
  }

  async publish(runId: string): Promise<void> {
    await Promise.race([
      this.pub.publish(CHANNEL, runId).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, PUBLISH_TIMEOUT_MS)),
    ]).catch(() => {});
  }

  subscribe(onCancel: (runId: string) => void): () => void {
    this.listeners.add(onCancel);
    if (!this.sub) {
      const sub = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      sub.on("error", () => {});
      const join = () => void sub.subscribe(CHANNEL).catch(() => {});
      join();
      // 重连后要重新订阅,否则断线一次之后再也收不到
      sub.on("ready", join);
      sub.on("message", (_ch, runId: string) => {
        for (const l of this.listeners) l(runId);
      });
      this.sub = sub;
    }
    return () => {
      this.listeners.delete(onCancel);
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub?.quit()]);
  }
}
