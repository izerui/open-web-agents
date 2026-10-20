import { runFinishedPayload } from "@/lib/modules/integration/application/webhook";
import { type RunRecord, publicCost, toRunResult } from "@/lib/modules/run/domain/run-result";
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

  describe("对外费用不含提供者与上游模型标识", () => {
    const stored = {
      usd: 0.02,
      input: 1200,
      output: 80,
      partial: true,
      metering: {
        source: "sdk_model_usage",
        complete: true,
        models: [
          {
            modelId: "upstream-x",
            inputTokens: 1200,
            outputTokens: 80,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
      // 原始估算(带上游标识)只留在库里
      creditEstimate: {
        totalMicroCredits: "3696000",
        complete: true,
        source: "sdk_model_usage",
        models: [
          {
            modelId: "upstream-x",
            inputTokens: 1200,
            outputTokens: 80,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            microCredits: "3696000",
            unpriced: false,
          },
        ],
      },
      // 只给结算与对账:所属提供者、模型目录 id ↔ 上游标识
      pricing: {
        providerId: "secret-provider-id",
        models: [{ capabilityId: "m-public", modelId: "upstream-x", version: 4 }],
      },
      // 结算时生成的对外版本:公开模型 id、名称、价目版本
      publicEstimate: {
        totalMicroCredits: "3696000",
        complete: true,
        models: [
          {
            model: "m-public",
            name: "主力模型",
            version: 4,
            inputTokens: 1200,
            outputTokens: 80,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            microCredits: "3696000",
            unpriced: false,
          },
        ],
      },
    };

    it("结果轮询 / 阻塞响应 / webhook:无提供者与上游模型标识,按模型给公开 id、名称、版本、token 与积分", () => {
      const rec = record({ cost: stored });
      for (const out of [toRunResult(rec), runFinishedPayload(rec, { sessionId: "s1" })]) {
        const text = JSON.stringify(out);
        expect(text).not.toContain("pricing");
        expect(text).not.toContain("secret-provider-id");
        expect(text).not.toContain("upstream-x");
        expect(text).not.toContain("metering");
        expect(out.cost).toEqual({
          usd: 0.02,
          input: 1200,
          output: 80,
          partial: true,
          creditEstimate: stored.publicEstimate,
        });
      }
    });

    it("没有费用或费用不是对象时为 null;未知字段一律不带出", () => {
      expect(toRunResult(record({ cost: null })).cost).toBeNull();
      expect(toRunResult(record({ cost: "x" })).cost).toBeNull();
      expect(publicCost({ input: 1, output: 2, anything: "leak" })).toEqual({
        input: 1,
        output: 2,
      });
    });
  });
});
