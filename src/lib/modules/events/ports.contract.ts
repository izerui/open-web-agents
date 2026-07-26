// BusPort 的【端口契约】测试套件。内存与 Redis adapter 跑同一套断言。
//
// Redis pub/sub 是异步的,契约用轮询等待而非固定 sleep,避免不稳定的 flaky 测试。

import type { BusPort } from "@/lib/modules/events/ports";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

export interface BusHarness {
  makeBus(): Promise<BusPort>;
  /** 每个 topic 用唯一后缀,避免跨用例串台(Redis 是共享实例)。 */
  topic(base: string): string;
}

/** 等到条件成立或超时,避免固定 sleep 带来的 flaky。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function busContract(name: string, harness: BusHarness): void {
  describe(`BusPort 契约:${name}`, () => {
    it("投递给同 topic 的订阅者", async () => {
      const bus = await harness.makeBus();
      const t = harness.topic("same");
      const got: AgentEvent[] = [];
      const off = bus.subscribe(t, (e) => got.push(e));
      await bus.ready?.(t);

      await bus.publish(t, { kind: "text", text: "hi" });
      await waitFor(() => got.length === 1);
      expect(got[0]).toEqual({ kind: "text", text: "hi" });
      off();
    });

    it("不投递给别的 topic", async () => {
      const bus = await harness.makeBus();
      const t1 = harness.topic("a");
      const t2 = harness.topic("b");
      const got: AgentEvent[] = [];
      const off = bus.subscribe(t1, (e) => got.push(e));
      const marker: AgentEvent[] = [];
      const off2 = bus.subscribe(t2, (e) => marker.push(e));
      await bus.ready?.(t1);
      await bus.ready?.(t2);

      await bus.publish(t2, { kind: "text", text: "other" });
      await waitFor(() => marker.length === 1);
      expect(got).toEqual([]);
      off();
      off2();
    });

    it("多订阅者都收到同一事件", async () => {
      const bus = await harness.makeBus();
      const t = harness.topic("multi");
      const a: AgentEvent[] = [];
      const b: AgentEvent[] = [];
      const offA = bus.subscribe(t, (e) => a.push(e));
      const offB = bus.subscribe(t, (e) => b.push(e));
      await bus.ready?.(t);

      await bus.publish(t, { kind: "text", text: "x" });
      await waitFor(() => a.length === 1 && b.length === 1);
      expect(a).toEqual(b);
      offA();
      offB();
    });

    it("退订后不再收到", async () => {
      const bus = await harness.makeBus();
      const t = harness.topic("unsub");
      // 见证 topic:它收到事件就说明投递已完成,可以断定退订者确实没收到(而非还没到)
      const witnessTopic = harness.topic("witness");

      const got: AgentEvent[] = [];
      const off = bus.subscribe(t, (e) => got.push(e));
      off();

      const witness: AgentEvent[] = [];
      const off2 = bus.subscribe(witnessTopic, (e) => witness.push(e));
      await bus.ready?.(witnessTopic);

      await bus.publish(t, { kind: "text", text: "x" });
      await bus.publish(witnessTopic, { kind: "text", text: "w" });
      await waitFor(() => witness.length === 1);
      expect(got).toEqual([]);
      off2();
    });

    it("完整保留事件结构(经序列化往返不失真)", async () => {
      const bus = await harness.makeBus();
      const t = harness.topic("shape");
      const got: AgentEvent[] = [];
      const off = bus.subscribe(t, (e) => got.push(e));
      await bus.ready?.(t);

      const rich: AgentEvent = {
        kind: "tool_use",
        tool: "Bash",
        input: { command: "ls", nested: { a: [1, 2] } },
        toolUseId: "tu_1",
        subagent: "reviewer",
      };
      await bus.publish(t, rich);
      await waitFor(() => got.length === 1);
      expect(got[0]).toEqual(rich);
      off();
    });

    it("ready 之后立即发布不丢消息(守护订阅注册竞态)", async () => {
      // Redis 的 SUBSCRIBE 是异步往返:曾经 subscribe() 一返回就 publish,
      // 订阅还没注册到服务端,消息静默丢失。ready() 必须能挡住这一类竞态。
      const bus = await harness.makeBus();
      for (let i = 0; i < 5; i++) {
        const t = harness.topic(`race-${i}`);
        const got: AgentEvent[] = [];
        const off = bus.subscribe(t, (e) => got.push(e));
        await bus.ready?.(t);
        await bus.publish(t, { kind: "text", text: `n${i}` });
        await waitFor(() => got.length === 1);
        expect(got).toHaveLength(1);
        off();
      }
    });

    it("无订阅者时发布不报错", async () => {
      const bus = await harness.makeBus();
      await expect(
        bus.publish(harness.topic("nobody"), { kind: "text", text: "x" }),
      ).resolves.toBeUndefined();
    });
  });
}
