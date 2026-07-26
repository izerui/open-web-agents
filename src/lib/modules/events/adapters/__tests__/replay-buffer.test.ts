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
