import { describe, expect, it } from "vitest";
import { evaluateQuota } from "../quota";

const M = 1_000_000; // 1 美元 = 100 万微美元

describe("evaluateQuota", () => {
  it("没设额度 = 不限,花多少都放行", () => {
    expect(evaluateQuota(999 * M, undefined).allowed).toBe(true);
  });

  it("未达上限放行", () => {
    expect(evaluateQuota(4 * M, 5 * M).allowed).toBe(true);
  });

  it("刚好等于上限就拦住 —— 不是超过才拦", () => {
    /*
     * 【为什么这条最容易写错】直觉会写成 `used > limit`。
     * 但额度的含义是"这个月最多花这么多":花费刚好等于上限时若还放行,
     * 那次运行的花费会把总额顶到上限【之上】,等于每个账号都能多花一次。
     */
    const v = evaluateQuota(5 * M, 5 * M);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("上限");
  });

  it("已经超了当然拦住", () => {
    expect(evaluateQuota(6 * M, 5 * M).allowed).toBe(false);
  });

  it("额度为 0 = 一分钱都不许花,和「没设额度」是两回事", () => {
    /*
     * 0 是个真实的运营手段:先把账号开着但不让它跑,等付款后再放开。
     * 如果实现里用 `if (!limit) return allow`,0 会被当成"没设",
     * 这个手段就失效了 —— 而且失效得悄无声息。
     */
    expect(evaluateQuota(0, 0).allowed).toBe(false);
    expect(evaluateQuota(0, undefined).allowed).toBe(true);
  });

  it("拒绝时把用量和上限都带出来,便于界面直接显示", () => {
    const v = evaluateQuota(7 * M, 5 * M);
    expect(v.usedMicroUsd).toBe(7 * M);
    expect(v.limitMicroUsd).toBe(5 * M);
    // 文案里要有具体数字,而不是干巴巴一句"超额了"
    expect(v.reason).toMatch(/\$/);
  });
});
