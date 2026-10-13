// 固定窗口限流(Redis INCR + PEXPIRE)。多实例共享计数。
//
// 【Redis 不可用时放行】限流是防滥用的辅助手段;因为 Redis 抖一下就让所有人登录不了,代价更大。

import Redis from "ioredis";

export interface RateLimitVerdict {
  allowed: boolean;
  /** 被拒时还要等多久(ms)。 */
  retryAfterMs: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitVerdict>;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on("error", () => {});
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitVerdict> {
    try {
      const k = `owa:rl:${key}`;
      const res = await this.redis.multi().incr(k).pttl(k).exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      let ttl = Number(res?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.redis.pexpire(k, windowMs);
        ttl = windowMs;
      }
      return count > limit
        ? { allowed: false, retryAfterMs: ttl }
        : { allowed: true, retryAfterMs: 0 };
    } catch {
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}
