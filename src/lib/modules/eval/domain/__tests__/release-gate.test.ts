import type { EvalRun } from "@/lib/modules/eval/ports";
import { describe, expect, it } from "vitest";
import { casesHash, publishBlockReason, verdictOf } from "../release-gate";

const c = (id: string, input: unknown = "x", name = id) => ({
  id,
  name,
  input,
  assertions: { contains: ["好"] },
});
const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: "r1",
  agentId: "a1",
  configHash: "h",
  casesHash: casesHash([c("1")]) ?? undefined,
  status: "done",
  total: 1,
  passed: 1,
  failed: 0,
  startedBy: "u",
  createdAt: 1,
  ...over,
});

describe("casesHash", () => {
  it("与顺序、名称无关;输入或断言变了就变;没有用例为 null", () => {
    expect(casesHash([c("1"), c("2")])).toBe(casesHash([c("2"), c("1", "x", "改名")]));
    expect(casesHash([c("1")])).not.toBe(casesHash([c("1", "y")]));
    expect(casesHash([c("1")])).not.toBe(
      casesHash([{ ...c("1"), assertions: { contains: ["坏"] } }]),
    );
    expect(casesHash([c("1")])).not.toBe(casesHash([c("1"), c("2")]));
    expect(casesHash([])).toBeNull();
  });
});

describe("verdictOf / publishBlockReason", () => {
  const current = casesHash([c("1")]);
  it("全部通过且用例未改:passed,可以发布", () => {
    const v = verdictOf(run(), current);
    expect(v.state).toBe("passed");
    expect(publishBlockReason(v)).toBeNull();
  });
  it("没有用例 / 没评测过 / 进行中 / 用例改了 / 没全部通过:都不能发布", () => {
    const states = [
      verdictOf(run(), null),
      verdictOf(undefined, current),
      verdictOf(run({ status: "running" }), current),
      verdictOf(run(), casesHash([c("1"), c("2")])),
      verdictOf(run({ casesHash: undefined }), current),
      verdictOf(run({ total: 2, passed: 1, failed: 1 }), current),
      verdictOf(run({ total: 0, passed: 0 }), current),
    ];
    expect(states.map((v) => v.state)).toEqual([
      "no_cases",
      "none",
      "running",
      "cases_changed",
      "cases_changed",
      "failed",
      "failed",
    ]);
    for (const v of states) expect(publishBlockReason(v)).toBeTruthy();
    expect(publishBlockReason(states[5] as never)).toContain("1/2");
  });
});
