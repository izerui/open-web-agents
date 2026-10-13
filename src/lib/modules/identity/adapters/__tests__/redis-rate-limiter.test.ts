// 限流器对真实 Redis 的测试。未配置 OWA_TEST_REDIS_URL 时跳过并说明。

import { randomUUID } from "node:crypto";
import { RedisRateLimiter } from "@/lib/modules/identity/adapters/redis-rate-limiter";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.OWA_TEST_REDIS_URL;

if (!URL_) {
  console.warn("[skip] RedisRateLimiter 测试未运行 —— 需设置 OWA_TEST_REDIS_URL");
  describe.skip("RedisRateLimiter(未配置 OWA_TEST_REDIS_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  const limiter = new RedisRateLimiter(URL_);
  const raw = new Redis(URL_);
  beforeAll(async () => {
    await limiter.ready();
  });
  afterAll(async () => {
    await limiter.close();
    raw.disconnect();
  });

  describe("RedisRateLimiter(真实 Redis)", () => {
    it("固定窗口:计数、剩余次数、超限后拒绝并给出等待时间", async () => {
      const key = `t:${randomUUID()}`;
      const a = await limiter.hit(key, 2, 10_000);
      expect(a).toMatchObject({ allowed: true, remaining: 1 });
      expect(a.resetMs).toBeGreaterThan(9_000);
      expect((await limiter.hit(key, 2, 10_000)).remaining).toBe(0);
      const c = await limiter.hit(key, 2, 10_000);
      expect(c.allowed).toBe(false);
      expect(c.retryAfterMs).toBeGreaterThan(0);
      expect(c.retryAfterMs).toBeLessThanOrEqual(10_000);
    });

    it("首次计数就设好过期时间", async () => {
      const key = `t:${randomUUID()}`;
      await limiter.hit(key, 5, 10_000);
      expect(await raw.pttl(`owa:rl:${key}`)).toBeGreaterThan(0);
    });

    it("残留的无过期计数键会被补上过期时间,而不是永久限流", async () => {
      const key = `t:${randomUUID()}`;
      // 模拟旧实现在 INCR 与 PEXPIRE 之间崩溃留下的键
      await raw.set(`owa:rl:${key}`, "99");
      expect(await raw.pttl(`owa:rl:${key}`)).toBe(-1);
      const v = await limiter.hit(key, 5, 10_000);
      expect(v.allowed).toBe(false);
      const ttl = await raw.pttl(`owa:rl:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10_000);
    });
  });

  describe("RedisRateLimiter:Redis 不可用", () => {
    it("放行,而不是把所有请求拒掉", async () => {
      const down = new RedisRateLimiter("redis://127.0.0.1:9");
      const v = await down.hit("x", 1, 1000);
      expect(v.allowed).toBe(true);
      await down.close();
    });
  });
}
