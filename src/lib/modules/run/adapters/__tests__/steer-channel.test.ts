// SteerChannel 的契约:内存与 Redis 两个实现跑同一套。Redis 部分需要 OWA_TEST_REDIS_URL,未配置时跳过。
//
// 核心不变式:被答复"已受理"的每一条,要么被 take 取走,要么被 close 取走 —— 一条不丢、一条不重。

import { randomUUID } from "node:crypto";
import { InMemorySteerChannel } from "@/lib/modules/run/adapters/in-memory-steer-channel";
import { RedisSteerChannel } from "@/lib/modules/run/adapters/redis-steer-channel";
import type { SteerChannel } from "@/lib/modules/run/ports";
import { afterAll, describe, expect, it } from "vitest";

function contract(name: string, make: () => SteerChannel) {
  describe(`SteerChannel 契约:${name}`, () => {
    const rid = () => `r-${randomUUID().slice(0, 8)}`;

    it("还没开始受理:拒绝", async () => {
      const ch = make();
      expect(await ch.offer(rid(), { id: "m", text: "x" })).toBe("closed");
    });

    it("受理后 take 取走;关闭时取走剩下的,之后一律拒绝", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("accepted");
      expect(await ch.take(r)).toEqual([{ id: "1", text: "一" }]);
      expect(await ch.take(r)).toEqual([]);
      expect(await ch.offer(r, { id: "2", text: "二" })).toBe("accepted");
      expect(await ch.close(r)).toEqual([{ id: "2", text: "二" }]);
      expect(await ch.offer(r, { id: "3", text: "三" })).toBe("closed");
      expect(await ch.take(r)).toEqual([]);
    });

    it("并发受理途中关闭:已受理的每一条恰好被取走一次", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      const taken: string[] = [];
      const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
      const offers = ids.map((id, i) =>
        (async () => {
          // 一部分在关闭之前、一部分在之后到达
          if (i % 3 === 0) await new Promise((ok) => setTimeout(ok, i));
          return { id, res: await ch.offer(r, { id, text: id }) };
        })(),
      );
      // worker:边取边等,途中关闭
      const worker = (async () => {
        for (let k = 0; k < 5; k++) {
          for (const m of await ch.take(r)) taken.push(m.id);
          await new Promise((ok) => setTimeout(ok, 3));
        }
        for (const m of await ch.close(r)) taken.push(m.id);
      })();
      const results = await Promise.all(offers);
      await worker;
      const accepted = results.filter((x) => x.res === "accepted").map((x) => x.id);
      expect([...taken].sort()).toEqual([...accepted].sort());
      expect(new Set(taken).size).toBe(taken.length);
      // 关闭之后到达的确实被拒了(用例确有两种到达时机)
      expect(results.some((x) => x.res === "closed")).toBe(true);
      expect(accepted.length).toBeGreaterThan(0);
    });

    it("结局:写了就等得到;没写在上限内返回 pending", async () => {
      const ch = make();
      const r = rid();
      await ch.settle(r, "a", "delivered");
      await ch.settle(r, "b", "dropped");
      expect(await ch.awaitOutcome(r, "a", 500)).toBe("delivered");
      expect(await ch.awaitOutcome(r, "b", 500)).toBe("dropped");
      const t0 = Date.now();
      expect(await ch.awaitOutcome(r, "c", 300)).toBe("pending");
      expect(Date.now() - t0).toBeLessThan(1_500);
    });

    it("受理时通知取用方", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      let hit = 0;
      const off = ch.onOffer(r, () => hit++);
      // Redis 订阅建立需要一点时间
      await new Promise((ok) => setTimeout(ok, 200));
      await ch.offer(r, { id: "1", text: "x" });
      for (let i = 0; i < 40 && hit === 0; i++) await new Promise((ok) => setTimeout(ok, 25));
      off();
      expect(hit).toBeGreaterThan(0);
    });
  });
}

contract("内存", () => new InMemorySteerChannel());

const REDIS = process.env.OWA_TEST_REDIS_URL;
if (REDIS) {
  const made: RedisSteerChannel[] = [];
  contract("Redis(真实)", () => {
    const c = new RedisSteerChannel(REDIS);
    made.push(c);
    return c;
  });
  afterAll(async () => {
    await Promise.all(made.map((c) => c.disconnect()));
  });
} else {
  console.warn("[skip] SteerChannel 的 Redis 契约未运行 —— 需设置 OWA_TEST_REDIS_URL");
}

describe("SteerChannel:Redis 不可达", () => {
  it("受理在等待上限内失败(接口据此答 503),而不是一直挂着", { timeout: 10_000 }, async () => {
    const ch = new RedisSteerChannel("redis://127.0.0.1:9");
    const t0 = Date.now();
    await expect(ch.offer("r", { id: "m", text: "x" })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(4_000);
    await ch.disconnect();
  });
});
