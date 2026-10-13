// 限流器对真实 Redis 的测试。未配置 OWA_TEST_REDIS_URL 时跳过并说明。

import { randomUUID } from "node:crypto";
import net from "node:net";
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

/**
 * 一个只会"连上之后装死"的 Redis:正常回应 ioredis 的就绪检查(INFO),
 * 之后收到的 EVAL 永远不回。用来模拟连接已建立、Redis 卡死 / 过载的故障。
 * 不依赖真实 Redis,所以不受 OWA_TEST_REDIS_URL 影响,始终运行。
 */
function hangingRedis(): Promise<{
  port: number;
  evals: () => number;
  close: () => Promise<void>;
}> {
  let evals = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (buf) => {
      // 按 RESP 数组的第一个参数(命令名)分派 —— 不能按文本包含判断:
      // ioredis 连上先发 CLIENT SETINFO,其中就含 "INFO"
      for (const m of buf.toString("utf8").matchAll(/\*\d+\r\n\$\d+\r\n([^\r]+)\r\n/g)) {
        const cmd = (m[1] ?? "").toUpperCase();
        if (cmd === "INFO") {
          const body = "# Server\r\nredis_version:7.0.0\r\nloading:0\r\n";
          sock.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
        } else if (cmd === "EVAL" || cmd === "EVALSHA") {
          evals++; // 永不回复
        } else {
          sock.write("+OK\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        evals: () => evals,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("RedisRateLimiter:连接已就绪但 EVAL 永不返回", () => {
  it("在等待上限内放行,而不是把请求一直挂住", async () => {
    const stub = await hangingRedis();
    const limiter = new RedisRateLimiter(`redis://127.0.0.1:${stub.port}`, {
      commandTimeoutMs: 200,
    });
    try {
      await limiter.ready(); // 确认是"连上了"而不是"连不上"
      const t0 = Date.now();
      const v = await limiter.hit("hang", 1, 1000);
      const ms = Date.now() - t0;
      expect(stub.evals()).toBe(1); // 命令确实发到了 Redis,只是没回
      expect(v.allowed).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThan(1000);
    } finally {
      await limiter.close();
      await stub.close();
    }
  });
});
