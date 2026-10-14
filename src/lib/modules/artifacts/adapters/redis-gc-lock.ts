// GC 的跨进程互斥:Redis SET NX PX + 令牌校验的释放。
//
// web 进程与每个 worker 进程都会定时触发 GC;不加锁就是 N 个进程同时扫全表、同时删目录。
//
// 【它只省掉重复扫描,不负责正确性】防误删靠会话行锁协议(SessionRepo.reclaimWorkspace /
// prepareWorkspace):每个目录的判定与改名都在该会话的行锁里完成,两个 GC 进程同时跑也只是
// 在同一把行锁上排队,后到的看到目录已挪走即跳过。所以 Redis 不可用 / 超时时照常跑 ——
// GC 不跑的代价是磁盘无界增长。
// 每条命令都有界等待(教训见 redis-rate-limiter.ts:连上但不回时,裸 await 会一直挂着)。

import { randomUUID } from "node:crypto";
import Redis from "ioredis";

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisGcLock {
  private readonly redis: Redis;

  constructor(
    redisUrl: string,
    private readonly opts: { key?: string; ttlMs?: number; commandTimeoutMs?: number } = {},
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on("error", () => {});
  }

  private bounded<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(
          () => reject(new Error("gc lock timeout")),
          this.opts.commandTimeoutMs ?? 500,
        );
      }),
    ]).finally(() => clearTimeout(t));
  }

  /** 拿到锁返回释放句柄;别人持有返回 null;Redis 不可用时返回空操作句柄(照常跑)。 */
  async acquire(): Promise<{ release(): Promise<void> } | null> {
    const key = this.opts.key ?? "owa:gc:lock";
    const token = randomUUID();
    let got: string | null;
    try {
      got = await this.bounded(
        this.redis.set(key, token, "PX", this.opts.ttlMs ?? 25 * 60_000, "NX"),
      );
    } catch {
      return { release: async () => {} };
    }
    if (got !== "OK") return null;
    return {
      release: async () => {
        await this.bounded(this.redis.eval(RELEASE, 1, key, token)).catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
