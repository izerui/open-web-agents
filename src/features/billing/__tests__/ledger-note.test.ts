import { describe, expect, it } from "vitest";
import {
  type LedgerRefs,
  ledgerNote,
  ledgerRefIds,
  mergeRefs,
  parseLedgerRef,
} from "../ledger-note";

const RUN = "3cf2edae-1111-2222-3333-444455556666";
const ORDER = "be162900-1f2e-4c3d-9a8b-7c6d5e4f3a21";

describe("parseLedgerRef:流水引用 → 类别", () => {
  it("运行的冻结、补扣、补记、退还", () => {
    expect(parseLedgerRef(`run:${RUN}:0`)).toEqual({ type: "run", runId: RUN, part: "hold", n: 0 });
    expect(parseLedgerRef(`run:${RUN}:2`)).toEqual({ type: "run", runId: RUN, part: "hold", n: 2 });
    expect(parseLedgerRef(`run:${RUN}:over`)).toEqual({ type: "run", runId: RUN, part: "over" });
    expect(parseLedgerRef(`run:${RUN}:late:57750000`)).toEqual({
      type: "run",
      runId: RUN,
      part: "late",
    });
    expect(parseLedgerRef(`run:${RUN}:refund:0`)).toEqual({
      type: "run",
      runId: RUN,
      part: "refund",
    });
  });
  it("套餐订单、批量发放、其余(人工发放的幂等键)", () => {
    expect(parseLedgerRef(`package-order:${ORDER}`)).toEqual({ type: "order", orderId: ORDER });
    expect(parseLedgerRef("batch:abc")).toEqual({ type: "batch" });
    expect(parseLedgerRef("credit-1")).toEqual({ type: "other" });
    expect(parseLedgerRef("run:")).toEqual({ type: "other" });
  });
});

describe("ledgerRefIds:一页流水里要查名字的运行与订单", () => {
  it("去重,只收运行和订单", () => {
    expect(
      ledgerRefIds([
        { reference: `run:${RUN}:0` },
        { reference: `run:${RUN}:0` },
        { reference: `run:${RUN}:refund:0` },
        { reference: `package-order:${ORDER}` },
        { reference: "credit-1" },
      ]),
    ).toEqual({ runIds: [RUN], orderIds: [ORDER] });
  });
});

const refs: LedgerRefs = {
  runs: { [RUN]: { agentName: "报销审核助手", source: "web" } },
  orders: { [ORDER]: { packageName: "标准包" } },
};
const e = (kind: "credit" | "reserve" | "settle" | "refund", reference: string, extra = {}) => ({
  kind,
  reference,
  amountMicroCredits: "32800000",
  ...extra,
});

describe("ledgerNote:流水「说明」写成可读的句子,不露内部引用", () => {
  it("运行:带短号、智能体名与来源", () => {
    expect(ledgerNote(e("reserve", `run:${RUN}:0`), refs)).toBe(
      "运行 3cf2edae 预冻结 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("reserve", `run:${RUN}:1`), refs)).toBe(
      "运行 3cf2edae 追加冻结 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("settle", `run:${RUN}:0`), refs)).toBe(
      "运行 3cf2edae 按实际用量扣除 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("settle", `run:${RUN}:0`, { amountMicroCredits: "0" }), refs)).toBe(
      "运行 3cf2edae 结束，冻结全部释放 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("settle", `run:${RUN}:over`), refs)).toBe(
      "运行 3cf2edae 超出冻结的部分补扣 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("reserve", `run:${RUN}:late:9`), refs)).toBe(
      "运行 3cf2edae 补记用量后补扣 · 报销审核助手（网页对话）",
    );
    expect(ledgerNote(e("refund", `run:${RUN}:refund:0`), refs)).toBe(
      "运行 3cf2edae 多扣的 32.8 积分退还 · 报销审核助手（网页对话）",
    );
  });
  it("运行查不到(已删除)时只写短号", () => {
    expect(ledgerNote(e("reserve", `run:${RUN}:0`), { runs: {}, orders: {} })).toBe(
      "运行 3cf2edae 预冻结",
    );
    expect(
      ledgerNote(e("reserve", `run:${RUN}:0`), {
        runs: { [RUN]: { agentName: null, source: "invoke" } },
        orders: {},
      }),
    ).toBe("运行 3cf2edae 预冻结 · 已删除的智能体（API 调用）");
  });
  it("套餐订单:套餐名 + 订单短号,管理员备注附在后面", () => {
    expect(ledgerNote(e("credit", `package-order:${ORDER}`), refs)).toBe(
      "购买「标准包」到账 · 订单 BE162900",
    );
    expect(ledgerNote(e("credit", `package-order:${ORDER}`, { reason: "已核对转账" }), refs)).toBe(
      "购买「标准包」到账 · 订单 BE162900 · 已核对转账",
    );
    expect(ledgerNote(e("credit", `package-order:${ORDER}`), { runs: {}, orders: {} })).toBe(
      "购买积分包到账 · 订单 BE162900",
    );
  });
  it("人工发放与批量发放写原因", () => {
    expect(ledgerNote(e("credit", "credit-1", { reason: "试用发放" }), refs)).toBe(
      "人工发放：试用发放",
    );
    expect(ledgerNote(e("credit", "batch:k1", { reason: "活动" }), refs)).toBe("批量发放：活动");
    expect(ledgerNote(e("credit", "credit-1"), refs)).toBe("人工发放");
  });
  it("认不出的引用:有原因写原因,否则写「其他」,不露原文", () => {
    expect(ledgerNote(e("settle", "weird:thing"), refs)).toBe("其他");
    expect(ledgerNote(e("settle", "weird:thing", { reason: "迁移" }), refs)).toBe("迁移");
  });
});

describe("mergeRefs", () => {
  it("翻页合并,缺省当空", () => {
    expect(mergeRefs(undefined, undefined)).toEqual({ runs: {}, orders: {} });
    expect(
      mergeRefs(
        { runs: { a: { agentName: "甲", source: "web" } }, orders: {} },
        { runs: { b: { agentName: null, source: null } }, orders: { o: { packageName: "包" } } },
      ),
    ).toEqual({
      runs: { a: { agentName: "甲", source: "web" }, b: { agentName: null, source: null } },
      orders: { o: { packageName: "包" } },
    });
  });
});
