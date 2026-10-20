import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { describe, expect, it } from "vitest";
import { type ReconRow, buildReconciliation, categorize } from "../reconciliation";

// 成本:输入 21 元/百万 token(2100 积分),输出 105 元/百万 token;售价另算
const model: Capability = {
  id: "m-main",
  name: "主力",
  kind: "llm",
  modelId: "up-main",
  enabled: true,
  acceptsImages: false,
  providerId: "p1",
  costRates: [
    { meter: "input_token", units: "1000000", microCredits: "2100000000" },
    { meter: "output_token", units: "1000000", microCredits: "10500000000" },
    { meter: "cache_read_token", units: "1000000", microCredits: "210000000" },
    { meter: "cache_write_token", units: "1000000", microCredits: "2625000000" },
  ],
  rates: [],
  version: 1,
  updatedAt: 0,
};
const metering = (models: { id: string; input: number; output: number }[], complete = true) => ({
  input: 0,
  output: 0,
  metering: {
    source: "sdk_model_usage",
    complete,
    models: models.map((m) => ({
      modelId: m.id,
      inputTokens: m.input,
      outputTokens: m.output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })),
  },
});
const row = (over: Partial<ReconRow>): ReconRow => ({
  day: "2026-10-20",
  providerId: "p1",
  state: "settled",
  started: true,
  finalWaitSettled: false,
  estimatedMicro: "0",
  chargedMicro: "0",
  cost: null,
  snapshot: null,
  models: [model],
  ...over,
});

describe("对账", () => {
  it("按数据来源归类,缺失数据不当成已核实的零", () => {
    expect(categorize(row({ cost: metering([{ id: "up-main", input: 1, output: 1 }]) }))).toBe(
      "complete",
    );
    expect(
      categorize(
        row({ state: "provisional", cost: metering([{ id: "up-main", input: 1, output: 1 }]) }),
      ),
    ).toBe("complete"); // 欠款的暂记:用量完整
    expect(categorize(row({ cost: metering([{ id: "other", input: 1, output: 1 }]) }))).toBe(
      "unpriced",
    );
    expect(categorize(row({ cost: { input: 1, output: 1 } }))).toBe("unpriced"); // 没有按模型的计量
    expect(categorize(row({ state: "provisional", snapshot: metering([]) }))).toBe(
      "snapshot_provisional",
    );
    expect(categorize(row({ snapshot: metering([]), finalWaitSettled: true }))).toBe(
      "snapshot_settled",
    );
    expect(categorize(row({ state: "provisional" }))).toBe("usage_unknown");
    expect(categorize(row({}))).toBe("no_usage_zero");
    expect(categorize(row({ started: false }))).toBe("not_started");
    expect(categorize(row({ state: "open" }))).toBe("open");
  });

  it("按提供者、日期汇总:成本估算只含能计价的部分,无法计价的 token 单列,缺失数据只计条数", () => {
    const lines = buildReconciliation([
      // 完整:1 万输入 + 1 千输出 → 成本 0.21 + 0.105 元 = 31.5 积分
      row({
        cost: metering([{ id: "up-main", input: 10000, output: 1000 }]),
        estimatedMicro: "34650000",
        chargedMicro: "34650000",
      }),
      // 无法完整计价:能算的 1 万输入(21 积分)计入,认不出的 5 千输入单列
      row({
        cost: metering([
          { id: "up-main", input: 10000, output: 0 },
          { id: "other", input: 5000, output: 0 },
        ]),
      }),
      // 快照暂记:2 万输入 → 42 积分
      row({
        state: "provisional",
        snapshot: metering([{ id: "up-main", input: 20000, output: 0 }]),
      }),
      // 缺失数据:只计条数
      row({ state: "provisional" }),
      row({}),
      row({ started: false }),
      row({ state: "open" }),
      // 另一个提供者、另一天
      row({
        day: "2026-10-19",
        providerId: "p2",
        models: null,
        cost: metering([{ id: "x", input: 7, output: 0 }]),
      }),
    ]);
    expect(lines.map((l) => [l.day, l.providerId])).toEqual([
      ["2026-10-20", "p1"],
      ["2026-10-19", "p2"],
    ]);
    const p1 = lines[0];
    expect(p1).toMatchObject({
      runs: 7,
      counts: {
        complete: 1,
        unpriced: 1,
        snapshot_provisional: 1,
        snapshot_settled: 0,
        usage_unknown: 1,
        no_usage_zero: 1,
        not_started: 1,
        open: 1,
      },
      tokens: { input: 45000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      unpricedTokens: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 },
      // 31.5 + 21 + 42 = 94.5 积分(0.945 元)
      costMicro: "94500000",
      estimatedMicro: "34650000",
      chargedMicro: "34650000",
    });
    // 取不到价目版本:全部按无法计价单列,成本估算为 0
    expect(lines[1]).toMatchObject({
      counts: { unpriced: 1 },
      unpricedTokens: { input: 7 },
      costMicro: "0",
    });
  });
});
