import { EventCoalescer } from "@/lib/modules/run/application/event-coalescer";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

function collect() {
  const out: AgentEvent[] = [];
  return { out, c: new EventCoalescer((e) => out.push(e), { windowMs: 10_000 }) };
}

describe("EventCoalescer", () => {
  it("相邻同类增量合并,flush 时冲出", () => {
    const { out, c } = collect();
    c.push({ kind: "text", text: "a" });
    c.push({ kind: "text", text: "b" });
    expect(out).toEqual([]);
    c.flush();
    expect(out).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("类型或子代理不同就分开,顺序保持", () => {
    const { out, c } = collect();
    c.push({ kind: "thinking", text: "想" });
    c.push({ kind: "text", text: "答" });
    c.push({ kind: "text", text: "子", subagent: "t1" });
    c.flush();
    expect(out.map((e) => (e as { text: string }).text)).toEqual(["想", "答", "子"]);
  });

  it("非文本事件先把缓冲冲出去", () => {
    const { out, c } = collect();
    c.push({ kind: "text", text: "a" });
    c.push({ kind: "status", label: "x" });
    expect(out).toEqual([
      { kind: "text", text: "a" },
      { kind: "status", label: "x" },
    ]);
  });

  it("超过单条上限立刻冲出", () => {
    const out: AgentEvent[] = [];
    const c = new EventCoalescer((e) => out.push(e), { windowMs: 10_000, maxChars: 3 });
    c.push({ kind: "text", text: "ab" });
    c.push({ kind: "text", text: "cd" });
    expect(out).toEqual([{ kind: "text", text: "abcd" }]);
  });

  it("窗口到点自动冲出", async () => {
    const out: AgentEvent[] = [];
    const c = new EventCoalescer((e) => out.push(e), { windowMs: 5 });
    c.push({ kind: "text", text: "a" });
    await new Promise((r) => setTimeout(r, 30));
    expect(out).toEqual([{ kind: "text", text: "a" }]);
  });
});
