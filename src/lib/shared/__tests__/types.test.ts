import { type AgentEvent, OWA_VERSION, type RunState } from "@/lib/shared";
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
