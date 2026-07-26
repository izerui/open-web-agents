import { type AgentEvent, OWA_VERSION, type RunState, isStateEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("shared", () => {
  it("暴露版本号", () => {
    expect(OWA_VERSION).toBe("0.0.1");
  });

  it("AgentEvent result 承载结构化结果", () => {
    const e: AgentEvent = { kind: "result", status: "success", structured: { ok: 1 } };
    expect(e.kind).toBe("result");
  });

  it("RunState 是已知字面量", () => {
    const s: RunState = "pending";
    expect(["pending", "running", "success", "failed", "cancelled"]).toContain(s);
  });
});

describe("isStateEvent", () => {
  it("state 类事件需重放", () => {
    expect(isStateEvent({ kind: "result", status: "success" })).toBe(true);
    expect(isStateEvent({ kind: "status", label: "渲染中" })).toBe(true);
    expect(isStateEvent({ kind: "usage", input: 1, output: 2 })).toBe(true);
    expect(isStateEvent({ kind: "artifact", path: "/a.mp4", mime: "video/mp4" })).toBe(true);
  });

  it("noise 类事件可淘汰", () => {
    expect(isStateEvent({ kind: "text", text: "hi" })).toBe(false);
    expect(isStateEvent({ kind: "thinking", text: "..." })).toBe(false);
    expect(isStateEvent({ kind: "tool_use", tool: "Bash", input: {} })).toBe(false);
    expect(isStateEvent({ kind: "tool_result", text: "done" })).toBe(false);
  });
});
