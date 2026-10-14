import {
  checkInvokeRate,
  rateLimitHeaders,
  validateKeyRateLimit,
} from "@/lib/modules/identity/application/invoke-rate-limit";
import type { RateLimiter } from "@/lib/modules/identity/ports";
import { describe, expect, it } from "vitest";

/** 内存固定窗口:只计数,不过期(测试里一个窗口就够)。 */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const limiter: RateLimiter = {
    async hit(key, limit, windowMs) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n > limit
        ? { allowed: false, retryAfterMs: windowMs, remaining: 0, resetMs: windowMs }
        : { allowed: true, retryAfterMs: 0, remaining: limit - n, resetMs: windowMs };
    },
  };
  return { limiter, counts };
}

const base = { keyId: "k1", agentId: "a1", defaultKeyLimit: 3, agentLimit: 5 };

describe("checkInvokeRate", () => {
  it("每把 Key 按平台默认限流,并回报剩余次数", async () => {
    const { limiter } = fakeLimiter();
    const r1 = await checkInvokeRate(limiter, base);
    expect(r1).toEqual({ allowed: true, key: { limit: 3, remaining: 2, resetMs: 60_000 } });
    await checkInvokeRate(limiter, base);
    await checkInvokeRate(limiter, base);
    expect(await checkInvokeRate(limiter, base)).toMatchObject({
      allowed: false,
      scope: "key",
      limit: 3,
    });
  });

  it("Key 单独设的上限优先于平台默认", async () => {
    const { limiter } = fakeLimiter();
    const input = { ...base, keyLimit: 1 };
    expect((await checkInvokeRate(limiter, input)).allowed).toBe(true);
    expect(await checkInvokeRate(limiter, input)).toMatchObject({ allowed: false, limit: 1 });
  });

  it("智能体上限按所有 Key 合计", async () => {
    const { limiter } = fakeLimiter();
    for (let i = 0; i < 5; i++) {
      expect((await checkInvokeRate(limiter, { ...base, keyId: `k${i}` })).allowed).toBe(true);
    }
    expect(await checkInvokeRate(limiter, { ...base, keyId: "k9" })).toMatchObject({
      allowed: false,
      scope: "agent",
      limit: 5,
    });
  });

  it("被 Key 上限拒掉的请求不占用智能体的公共配额", async () => {
    const { limiter, counts } = fakeLimiter();
    const input = { ...base, keyLimit: 1 };
    await checkInvokeRate(limiter, input);
    await checkInvokeRate(limiter, input);
    await checkInvokeRate(limiter, input);
    expect(counts.get("invoke:agent:a1")).toBe(1);
  });

  it("0 = 不限:不计数,也不回报 Key 配额", async () => {
    const { limiter, counts } = fakeLimiter();
    const r = await checkInvokeRate(limiter, { ...base, defaultKeyLimit: 0, agentLimit: 0 });
    expect(r).toEqual({ allowed: true, key: undefined });
    expect(counts.size).toBe(0);
  });
});

describe("validateKeyRateLimit", () => {
  it("普通用户只能调得比平台默认更严;管理员不受限;null 恢复默认", () => {
    expect(validateKeyRateLimit(10, { isAdmin: false, platformDefault: 60 })).toEqual({
      ok: true,
      value: 10,
    });
    expect(validateKeyRateLimit(61, { isAdmin: false, platformDefault: 60 }).ok).toBe(false);
    expect(validateKeyRateLimit(5000, { isAdmin: true, platformDefault: 60 }).ok).toBe(true);
    expect(validateKeyRateLimit(null, { isAdmin: false, platformDefault: 60 })).toEqual({
      ok: true,
      value: null,
    });
    // 平台默认关闭(0)时,普通用户设多少都只是让自己更严
    expect(validateKeyRateLimit(500, { isAdmin: false, platformDefault: 0 }).ok).toBe(true);
  });

  it("非正整数一律拒绝", () => {
    for (const bad of [0, -1, 1.5, "10", true, 100_001]) {
      expect(validateKeyRateLimit(bad, { isAdmin: true, platformDefault: 60 }).ok).toBe(false);
    }
  });
});

describe("rateLimitHeaders", () => {
  it("重置时间向上取整到秒", () => {
    expect(rateLimitHeaders({ limit: 60, remaining: 0, resetMs: 1500 })).toEqual({
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "2",
    });
  });
});
