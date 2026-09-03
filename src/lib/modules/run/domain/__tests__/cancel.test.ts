import { cancellableRunIds } from "@/lib/modules/run/domain/cancel";
import { describe, expect, it } from "vitest";

const runs = [
  { id: "pending", status: "pending" },
  { id: "running", status: "running" },
  { id: "success", status: "success" },
  { id: "cancelled", status: "cancelled" },
];

describe("cancellableRunIds", () => {
  it("没有指定 runId 时只返回当前会话里的活跃运行", () => {
    expect(cancellableRunIds(runs)).toEqual(["pending", "running"]);
  });

  it("指定的 runId 不属于当前会话时不返回任何目标", () => {
    expect(cancellableRunIds(runs, "other-session-run")).toEqual([]);
  });

  it("已经终态的运行不能再次取消", () => {
    expect(cancellableRunIds(runs, "success")).toEqual([]);
    expect(cancellableRunIds(runs, "cancelled")).toEqual([]);
  });

  it("只返回明确指定的当前活跃运行", () => {
    expect(cancellableRunIds(runs, "running")).toEqual(["running"]);
  });
});
