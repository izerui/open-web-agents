import { runFinishedPayload } from "@/lib/modules/integration/application/webhook";
import { type RunRecord, toRunResult } from "@/lib/modules/run/domain/run-result";
import { describe, expect, it } from "vitest";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "t1",
  status: "success",
  structured: { verdict: "pass" },
  salvaged: true,
  finalText: "通过",
  cost: { usd: 0.01, input: 10, output: 5 },
  error: null,
  agentVersion: 3,
  startedAt: new Date("2026-10-14T01:00:00Z"),
  endedAt: new Date("2026-10-14T01:00:05Z"),
  ...over,
});

/** 对外结果契约的全部字段 */
const CONTRACT = [
  "taskId",
  "status",
  "done",
  "agentVersion",
  "structured",
  "salvaged",
  "text",
  "error",
  "cost",
  "startedAt",
  "endedAt",
].sort();

describe("toRunResult", () => {
  it("字段齐全;时间是 ISO;salvaged 原样带出", () => {
    const r = toRunResult(record());
    expect(Object.keys(r).sort()).toEqual(CONTRACT);
    expect(r).toMatchObject({
      taskId: "t1",
      done: true,
      salvaged: true,
      text: "通过",
      agentVersion: 3,
      startedAt: "2026-10-14T01:00:00.000Z",
      endedAt: "2026-10-14T01:00:05.000Z",
    });
  });

  it("未结束:done=false;空值统一为 null;旧记录没有 salvaged 视为 false", () => {
    const r = toRunResult(
      record({
        status: "running",
        structured: undefined,
        salvaged: null,
        finalText: null,
        cost: undefined,
        error: undefined,
        agentVersion: null,
        endedAt: null,
      }),
    );
    expect(r).toMatchObject({
      done: false,
      structured: null,
      salvaged: false,
      text: null,
      cost: null,
      error: null,
      agentVersion: null,
      endedAt: null,
    });
  });
});

describe("webhook 回调载荷与 /result 同一份契约", () => {
  it("载荷包含契约的全部字段且取值一致,另带投递元信息与已废弃的 summary", () => {
    const rec = record();
    const p = runFinishedPayload(rec, { sessionId: "s1", agentId: "a1" }) as unknown as Record<
      string,
      unknown
    >;
    const r = toRunResult(rec) as unknown as Record<string, unknown>;
    for (const k of CONTRACT) expect(p[k]).toEqual(r[k]);
    expect(p).toMatchObject({
      deliveryId: "t1",
      event: "run.finished",
      sessionId: "s1",
      agentId: "a1",
      summary: "通过",
    });
  });
});
