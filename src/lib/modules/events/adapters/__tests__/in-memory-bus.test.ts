import { InMemoryBus } from "@/lib/modules/events/adapters/in-memory-bus";
import { describe, expect, it } from "vitest";

describe("InMemoryBus", () => {
  it("只投递给同 topic 的订阅者", async () => {
    const bus = new InMemoryBus();
    const got: string[] = [];
    bus.subscribe("t1", (e) => {
      if (e.kind === "text") got.push(e.text);
    });
    await bus.publish("t1", { kind: "text", text: "hi" });
    await bus.publish("t2", { kind: "text", text: "other" });
    expect(got).toEqual(["hi"]);
  });

  it("多订阅者都收到", async () => {
    const bus = new InMemoryBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe("t", (e) => e.kind === "text" && a.push(e.text));
    bus.subscribe("t", (e) => e.kind === "text" && b.push(e.text));
    await bus.publish("t", { kind: "text", text: "x" });
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("退订后不再投递", async () => {
    const bus = new InMemoryBus();
    const got: string[] = [];
    const off = bus.subscribe("t", (e) => e.kind === "text" && got.push(e.text));
    off();
    await bus.publish("t", { kind: "text", text: "x" });
    expect(got).toEqual([]);
  });

  it("回调内退订不打乱本次派发", async () => {
    const bus = new InMemoryBus();
    const got: string[] = [];
    const off1 = bus.subscribe("t", () => off1());
    bus.subscribe("t", (e) => e.kind === "text" && got.push(e.text));
    await bus.publish("t", { kind: "text", text: "x" });
    expect(got).toEqual(["x"]);
  });

  it("无订阅者时发布不报错", async () => {
    const bus = new InMemoryBus();
    await expect(bus.publish("nobody", { kind: "text", text: "x" })).resolves.toBeUndefined();
  });
});
