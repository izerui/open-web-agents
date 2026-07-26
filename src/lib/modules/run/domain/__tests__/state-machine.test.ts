import { isTerminal, nextRunState } from "@/lib/modules/run/domain/state-machine";
import { describe, expect, it } from "vitest";

describe("nextRunState", () => {
  it("pending --claim--> running", () => {
    expect(nextRunState("pending", "claim")).toBe("running");
  });
  it("running --finishOk--> success", () => {
    expect(nextRunState("running", "finishOk")).toBe("success");
  });
  it("running --finishErr--> failed", () => {
    expect(nextRunState("running", "finishErr")).toBe("failed");
  });
  it("pending --cancel--> cancelled", () => {
    expect(nextRunState("pending", "cancel")).toBe("cancelled");
  });
  it("running --cancel--> cancelled", () => {
    expect(nextRunState("running", "cancel")).toBe("cancelled");
  });
  it("拒绝非法迁移 success--claim", () => {
    expect(() => nextRunState("success", "claim")).toThrow(/illegal/i);
  });
  it("拒绝从终态取消", () => {
    expect(() => nextRunState("failed", "cancel")).toThrow(/illegal/i);
    expect(() => nextRunState("cancelled", "cancel")).toThrow(/illegal/i);
  });
  it("拒绝跳过 running 直接完成", () => {
    expect(() => nextRunState("pending", "finishOk")).toThrow(/illegal/i);
  });
});

describe("isTerminal", () => {
  it("三个终态", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });
  it("非终态", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});
