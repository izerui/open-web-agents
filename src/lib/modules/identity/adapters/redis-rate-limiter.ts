// 固定窗口限流(Redis 计数 + 过期)。多实例共享计数。
//
// 【Redis 不可用时放行】限流是防滥用的辅助手段;因为 Redis 抖一下就让所有人登录不了、
// 接口全部 429,代价更大。花费另有额度关卡兜底。

import type { RateLimitVerdict, RateLimiter } from "@/lib/modules/identity/ports";
import Redis from "ioredis";

export type { RateLimitVerdict, RateLimiter };

/**
 * 计数与设过期必须原子。
 *
 * 曾经是 MULTI(INCR, PTTL) 之后再单独 PEXPIRE:进程在两步之间崩溃、或那一次 PEXPIRE 因
 * 连接抖动失败,计数键就永不过期 —— 该账号的登录从此一直被限流,直到有人手工删键。
 * 现在一段 Lua 完成:首次计数设过期;发现没有过期时间的残留键也补上。
 */
const HIT = `
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;

  /**
   * 不排队(enableOfflineQueue: false):连接不可用时命令立刻失败、走放行分支,
   * 而不是让每个请求卡在等 Redis 上。代价是进程刚启动、连接还没建好的那几毫秒里也会放行。
   */
  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on("error", () => {});
  }

  /** 等连接就绪(测试用;生产在启动时创建,首个请求到来前通常已就绪)。 */
  async ready(timeoutMs = 5000): Promise<void> {
    if (this.redis.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("redis not ready")), timeoutMs);
      this.redis.once("ready", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitVerdict> {
    try {
      const [count, ttl] = (await this.redis.eval(HIT, 1, `owa:rl:${key}`, windowMs)) as [
        number,
        number,
      ];
      return count > limit
        ? { allowed: false, retryAfterMs: ttl, remaining: 0, resetMs: ttl }
        : { allowed: true, retryAfterMs: 0, remaining: limit - count, resetMs: ttl };
    } catch {
      return { allowed: true, retryAfterMs: 0, remaining: limit, resetMs: windowMs };
    }
  }

  /** 测试用:关闭连接。 */
  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
