// 同一套总线契约,内存与 Redis 都必须通过。
// Redis 用例需真实服务:未配置 OWA_TEST_REDIS_URL 时跳过并明确说明。

import { randomUUID } from "node:crypto";
import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { RedisBus } from "@/lib/modules/events/adapters/redis-bus";
import { busContract } from "@/lib/modules/events/ports.contract";
import Redis from "ioredis";
import { afterAll, expect, it } from "vitest";

const suffix = () => randomUUID().slice(0, 8);

const memBus = new InMemoryBus();
busContract("InMemoryBus", {
  makeBus: async () => memBus,
  topic: (base) => `mem:${base}:${suffix()}`,
});

const TEST_REDIS_URL = process.env.OWA_TEST_REDIS_URL;

if (TEST_REDIS_URL) {
  const bus = new RedisBus(TEST_REDIS_URL);
  const prefix = `owa-test:${suffix()}`;
  busContract("RedisBus(真实 Redis)", {
    makeBus: async () => bus,
    topic: (base) => `${prefix}:${base}:${suffix()}`,
  });
  it("Redis Stream 设置过期时间,不会永久占用内存", async () => {
    const topic = `${prefix}:ttl:${suffix()}`;
    await bus.publish(topic, { kind: "text", text: "hi" });
    const inspect = new Redis(TEST_REDIS_URL);
    expect(await inspect.ttl(topic)).toBeGreaterThan(0);
    await inspect.quit();
  });
  afterAll(async () => {
    await bus.close();
    const cleanup = new Redis(TEST_REDIS_URL);
    const keys = await cleanup.keys(`${prefix}:*`);
    if (keys.length > 0) await cleanup.del(...keys);
    await cleanup.quit();
  });
} else {
  console.warn("[skip] RedisBus 契约测试未运行 —— 需设置 OWA_TEST_REDIS_URL");
}
