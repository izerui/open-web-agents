import { ReplayBuffer } from "@/lib/modules/events/adapters/replay-buffer";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const T = "session:s1";

describe("ReplayBuffer", () => {
  it("未记录过的 topic 回放为空", () => {
    expect(new ReplayBuffer().replay("nope")).toEqual({ events: [], done: false });
  });

  it("state 类事件全部保留(少一条就重建不出状态)", () => {
    const b = new ReplayBuffer(2);
    b.record(T, { kind: "status", label: "1" });
    b.record(T, { kind: "usage", input: 1, output: 1 });
    b.record(T, { kind: "artifact", path: "a", mime: "text/plain" });
    b.record(T, { kind: "status", label: "2" });
    const { events } = b.replay(T);
    expect(events).toHaveLength(4);
  });

  it("noise 类事件滚动淘汰,只保最近若干条", () => {
    const b = new ReplayBuffer(3);
    for (let i = 0; i < 10; i++) b.record(T, { kind: "text", text: `n${i}` });
    const { events } = b.replay(T);
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.kind === "text" ? e.text : ""))).toEqual(["n7", "n8", "n9"]);
  });

  it("回放顺序:noise 在前、state 在后", () => {
    const b = new ReplayBuffer();
    b.record(T, { kind: "status", label: "开始" });
    b.record(T, { kind: "text", text: "过程" });
    const { events } = b.replay(T);
    expect(events.map((e) => e.kind)).toEqual(["text", "status"]);
  });

  it("收到 result 即标记 done,供重连判断是否还需挂流", () => {
    const b = new ReplayBuffer();
    expect(b.replay(T).done).toBe(false);
    b.record(T, { kind: "result", status: "success" });
    expect(b.replay(T).done).toBe(true);
  });

  it("topic 之间互不干扰", () => {
    const b = new ReplayBuffer();
    b.record("session:a", { kind: "text", text: "A" });
    b.record("session:b", { kind: "text", text: "B" });
    expect(b.replay("session:a").events).toHaveLength(1);
    expect((b.replay("session:b").events[0] as { text: string }).text).toBe("B");
  });

  it("reset 清空,不把上一轮事件重放给下一轮", () => {
    const b = new ReplayBuffer();
    b.record(T, { kind: "result", status: "success" });
    b.reset(T);
    expect(b.replay(T)).toEqual({ events: [], done: false });
  });

  it("evictOlderThan 清理久未更新的会话", () => {
    const b = new ReplayBuffer();
    b.record(T, { kind: "text", text: "x" });
    expect(b.evictOlderThan(1000, Date.now() + 5000)).toBe(1);
    expect(b.replay(T).events).toEqual([]);
  });

  it("evictOlderThan 不动仍活跃的会话", () => {
    const b = new ReplayBuffer();
    b.record(T, { kind: "text", text: "x" });
    expect(b.evictOlderThan(60_000)).toBe(0);
  });

  it("state 与 noise 混合时都按各自规则处理", () => {
    const b = new ReplayBuffer(2);
    const seq: AgentEvent[] = [
      { kind: "text", text: "a" },
      { kind: "status", label: "s1" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
      { kind: "result", status: "success" },
    ];
    for (const e of seq) b.record(T, e);
    const { events, done } = b.replay(T);
    // noise 只留最后 2 条(b、c),state 全留(s1、result)
    expect(events.map((e) => e.kind)).toEqual(["text", "text", "status", "result"]);
    expect(done).toBe(true);
  });
});

// 同会话并发两轮时的串台。曾经缓冲按【会话】存,于是:
//  - 后开始的那轮 reset(会话) 把前一轮的整个过程记录删掉,刷新页面也拿不回来
//  - 先结束那轮的 result 把整个会话标成 done,/events 回放完直接收流,
//    即使另一轮还在跑
// 分桶到 run 粒度之后两边互不干扰。
describe("ReplayBuffer / 【串台回归】按运行分桶", () => {
  const scope = "session:s1:run:";
  const runA = `${scope}a`;
  const runB = `${scope}b`;

  it("一轮 reset 不影响另一轮的记录", () => {
    const b = new ReplayBuffer();
    b.record(runA, { kind: "text", text: "A 的过程" });
    b.reset(runB); // B 开始时清自己的桶
    b.record(runB, { kind: "text", text: "B 的过程" });

    expect(b.replay(runA).events).toHaveLength(1);
    expect(b.replay(runB).events).toHaveLength(1);
  });

  it("合并回放拿得到两轮的全部事件", () => {
    const b = new ReplayBuffer();
    b.record(runA, { kind: "text", text: "A" });
    b.record(runB, { kind: "text", text: "B" });
    const { events } = b.replayScope(scope);
    expect(events.map((e) => (e.kind === "text" ? e.text : e.kind)).sort()).toEqual(["A", "B"]);
  });

  it("【核心】只有一轮结束时 done=false —— 另一轮还在跑就不能收流", () => {
    const b = new ReplayBuffer();
    b.record(runA, { kind: "text", text: "A" });
    b.record(runB, { kind: "text", text: "B" });
    b.record(runA, { kind: "result", status: "success", runId: "a" });

    const r = b.replayScope(scope);
    expect(r.done).toBe(false);
    expect(r.open).toEqual(["b"]); // 未收尾的那轮被如实报出来
  });

  it("两轮都结束才算 done", () => {
    const b = new ReplayBuffer();
    b.record(runA, { kind: "result", status: "success", runId: "a" });
    b.record(runB, { kind: "result", status: "failed", runId: "b" });
    const r = b.replayScope(scope);
    expect(r.done).toBe(true);
    expect(r.open).toEqual([]);
  });

  it("前缀不匹配的会话不会被误合并", () => {
    const b = new ReplayBuffer();
    b.record("session:s1:run:a", { kind: "text", text: "属于 s1" });
    b.record("session:s2:run:a", { kind: "text", text: "属于 s2" });
    expect(b.replayScope("session:s1:run:").events).toHaveLength(1);
  });

  it("没有任何桶时 done=false —— 不能把「还没开始」当成「已跑完」", () => {
    const b = new ReplayBuffer();
    expect(b.replayScope("session:nobody:run:")).toEqual({ events: [], done: false, open: [] });
  });
});
