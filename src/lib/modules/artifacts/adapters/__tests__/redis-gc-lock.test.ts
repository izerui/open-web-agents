// GC 锁对真实 Redis 的测试。未配置 OWA_TEST_REDIS_URL 时只跑"Redis 不可用"那一条。

import { randomUUID } from "node:crypto";
import { RedisGcLock } from "@/lib/modules/artifacts/adapters/redis-gc-lock";
import { afterAll, describe, expect, it } from "vitest";

const URL_ = process.env.OWA_TEST_REDIS_URL;

describe("RedisGcLock:Redis 不可用", () => {
  it("返回空操作句柄(照常跑 GC),而且有界返回", async () => {
    const lock = new RedisGcLock("redis://127.0.0.1:9", { commandTimeoutMs: 200 });
    const t0 = Date.now();
    const h = await lock.acquire();
    expect(h).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    await h?.release();
    await lock.close();
  });
});

describe.skipIf(!URL_)("RedisGcLock(真实 Redis)", () => {
  const key = `owa:test:gc:${randomUUID()}`;
  const a = new RedisGcLock(URL_ as string, { key, ttlMs: 5000 });
  const b = new RedisGcLock(URL_ as string, { key, ttlMs: 5000 });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it("同一时刻只有一个持有者;释放后别人可以拿到", async () => {
    await new Promise((r) => setTimeout(r, 200)); // 等连接就绪
    const h1 = await a.acquire();
    expect(h1).not.toBeNull();
    expect(await b.acquire()).toBeNull();
    await h1?.release();
    const h2 = await b.acquire();
    expect(h2).not.toBeNull();
    await h2?.release();
  });

  it("过期后被别人拿走,原持有者的释放不会删掉别人的锁", async () => {
    const short = new RedisGcLock(URL_ as string, { key: `${key}:x`, ttlMs: 200 });
    const other = new RedisGcLock(URL_ as string, { key: `${key}:x`, ttlMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    const stale = await short.acquire();
    await new Promise((r) => setTimeout(r, 400)); // 过期
    const fresh = await other.acquire();
    expect(fresh).not.toBeNull();
    await stale?.release(); // 令牌不符,不应删除
    expect(await short.acquire()).toBeNull();
    await fresh?.release();
    await short.close();
    await other.close();
  });
});
