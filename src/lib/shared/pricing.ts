import type { PinnedPricing, UnavailableAtAdmission } from "./types";

/** 受理时模型就不可用的运行:执行时必须照此失败,不能当成缺快照的旧任务重新解析 */
export function isUnavailableAtAdmission(
  p: PinnedPricing | null | undefined,
): p is UnavailableAtAdmission {
  return !!p && typeof p === "object" && "unavailableAtAdmission" in p;
}
