// SteerChannel 的契约:内存与 Redis 两个实现跑同一套。Redis 部分需要 OWA_TEST_REDIS_URL,未配置时跳过。
//
// 不变式:
//   - 受理与关闭对同一状态互斥;关闭后不再受理
//   - 读取只读不删,只有记下结局才删 —— 读取的响应丢了,消息也还在
//   - 同一 id 只入队一次;没受理时留下记录,迟到执行的同 id 受理不会再入队

import { randomUUID } from "node:crypto";
import { InMemorySteerChannel } from "@/lib/modules/run/adapters/in-memory-steer-channel";
import { RedisSteerChannel } from "@/lib/modules/run/adapters/redis-steer-channel";
import type { SteerChannel } from "@/lib/modules/run/ports";
import { afterAll, describe, expect, it } from "vitest";

const rid = () => `r-${randomUUID().slice(0, 8)}`;
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

function contract(name: string, make: () => SteerChannel) {
  describe(`SteerChannel 契约:${name}`, () => {
    it("还没开始受理:拒绝,并留下记录 —— 之后同一 id 再来(哪怕已开始受理)仍是拒绝", async () => {
      const ch = make();
      const r = rid();
      expect(await ch.offer(r, { id: "m", text: "x" })).toBe("rejected");
      await ch.open(r);
      // 模拟:超时的那次受理请求在离线队列里,开始受理之后才真正执行
      expect(await ch.offer(r, { id: "m", text: "x" })).toBe("rejected");
      expect(await ch.take(r)).toEqual([]);
    });

    it("读取只读不删;记下结局才删", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("accepted");
      expect(await ch.take(r)).toEqual([{ id: "1", text: "一" }]);
      expect(await ch.take(r)).toEqual([{ id: "1", text: "一" }]);
      await ch.settle(r, "1", "delivered");
      expect(await ch.take(r)).toEqual([]);
    });

    it("同一 id 只入队一次;有结局之后再受理答的是那个结局", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("accepted");
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("accepted");
      expect(ids(await ch.take(r))).toEqual(["1"]);
      await ch.settle(r, "1", "delivered");
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("delivered");
      expect(await ch.take(r)).toEqual([]);
    });

    it("关闭:之后不再受理;关闭时读到还没结局的(不删)", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      await ch.offer(r, { id: "1", text: "一" });
      await ch.offer(r, { id: "2", text: "二" });
      await ch.settle(r, "1", "delivered");
      expect(ids(await ch.close(r))).toEqual(["2"]);
      expect(ids(await ch.close(r))).toEqual(["2"]); // 再读一遍仍在
      expect(await ch.offer(r, { id: "3", text: "三" })).toBe("rejected");
    });

    it("并发受理途中关闭:已受理的每一条都读得到,关闭后到达的一律不受理", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      const all = Array.from({ length: 60 }, (_, i) => `m${i}`);
      const offers = all.map((id, i) =>
        (async () => {
          if (i % 3 === 0) await new Promise((ok) => setTimeout(ok, i));
          return { id, res: await ch.offer(r, { id, text: id }) };
        })(),
      );
      await new Promise((ok) => setTimeout(ok, 10));
      const atClose = ids(await ch.close(r));
      const results = await Promise.all(offers);
      const accepted = results.filter((x) => x.res === "accepted").map((x) => x.id);
      expect([...atClose].sort()).toEqual([...accepted].sort());
      expect(results.every((x) => x.res === "accepted" || x.res === "rejected")).toBe(true);
      expect(results.some((x) => x.res === "rejected")).toBe(true);
    });

    it("结局:写了就等得到;没写在上限内返回 pending", async () => {
      const ch = make();
      const r = rid();
      await ch.open(r);
      await ch.offer(r, { id: "a", text: "a" });
      await ch.offer(r, { id: "b", text: "b" });
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
      await new Promise((ok) => setTimeout(ok, 200)); // Redis 订阅建立需要一点时间
      await ch.offer(r, { id: "1", text: "x" });
      for (let i = 0; i < 40 && hit === 0; i++) await new Promise((ok) => setTimeout(ok, 25));
      off();
      expect(hit).toBeGreaterThan(0);
    });
  });
}

contract("内存", () => new InMemorySteerChannel());

const REDIS = process.env.OWA_TEST_REDIS_URL;

/** 让指定操作"已执行、但响应迟于等待上限":真的执行完,再拖过上限 —— 调用方拿到超时错误 */
class LateRedisSteerChannel extends RedisSteerChannel {
  readonly late = new Set<string>();
  constructor(url: string) {
    super(url, { commandTimeoutMs: 300 });
  }
  protected override exec<T>(what: string, run: () => Promise<T>): Promise<T> {
    if (!this.late.has(what)) return super.exec(what, run);
    this.late.delete(what);
    return super.exec(what, async () => {
      const v = await run(); // 脚本已在 Redis 里执行完
      await new Promise((ok) => setTimeout(ok, 600)); // 响应迟到,超过上限
      return v;
    });
  }
}

if (REDIS) {
  const made: RedisSteerChannel[] = [];
  const track = <C extends RedisSteerChannel>(c: C) => {
    made.push(c);
    return c;
  };
  contract("Redis(真实)", () => track(new RedisSteerChannel(REDIS)));

  describe("Redis:脚本已执行、响应超过等待上限", () => {
    it("读取的响应迟到:调用方拿到错误,但消息没被删,下一次读取仍在", async () => {
      const ch = track(new LateRedisSteerChannel(REDIS));
      const r = rid();
      await ch.open(r);
      await ch.offer(r, { id: "1", text: "一" });
      ch.late.add("take");
      await expect(ch.take(r)).rejects.toThrow(/未返回/);
      expect(await ch.take(r)).toEqual([{ id: "1", text: "一" }]);
    });

    it("关闭的响应迟到:关闭已生效(不再受理),还没结局的仍读得到", async () => {
      const ch = track(new LateRedisSteerChannel(REDIS));
      const r = rid();
      await ch.open(r);
      await ch.offer(r, { id: "1", text: "一" });
      ch.late.add("close");
      await expect(ch.close(r)).rejects.toThrow(/未返回/);
      expect(await ch.offer(r, { id: "2", text: "二" })).toBe("rejected");
      expect(ids(await ch.close(r))).toEqual(["1"]);
    });

    it("受理的响应迟到:其实已入队;用同一 id 再受理不会入第二份", async () => {
      const ch = track(new LateRedisSteerChannel(REDIS));
      const r = rid();
      await ch.open(r);
      ch.late.add("offer");
      await expect(ch.offer(r, { id: "1", text: "一" })).rejects.toThrow(/未返回/);
      expect(await ch.offer(r, { id: "1", text: "一" })).toBe("accepted");
      expect(ids(await ch.take(r))).toEqual(["1"]);
    });
  });

  afterAll(async () => {
    await Promise.all(made.map((c) => c.disconnect()));
  });
} else {
  console.warn("[skip] SteerChannel 的 Redis 契约未运行 —— 需设置 OWA_TEST_REDIS_URL");
}

describe("SteerChannel:Redis 不可达", () => {
  it("在等待上限内失败,而不是一直挂着", { timeout: 10_000 }, async () => {
    const ch = new RedisSteerChannel("redis://127.0.0.1:9");
    const t0 = Date.now();
    await expect(ch.offer("r", { id: "m", text: "x" })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(4_000);
    await ch.disconnect();
  });
});
