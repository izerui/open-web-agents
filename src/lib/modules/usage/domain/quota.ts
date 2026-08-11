import { formatUsd } from "./aggregate";

export interface QuotaVerdict {
  allowed: boolean;
  /** 拒绝时给用户看的话。允许时为 undefined。 */
  reason?: string;
  usedMicroUsd: number;
  limitMicroUsd?: number;
}

/**
 * 本月花费是否还允许再发起一次运行。
 *
 * 【为什么是纯函数】"取花费"和"取额度"是 IO,而"够不够"是规则。
 * 把规则单独拎出来,边界条件(刚好等于上限、额度为 0、没设额度)
 * 才测得动 —— 这几条恰恰是最容易写错的。
 */
export function evaluateQuota(usedMicroUsd: number, limitMicroUsd?: number): QuotaVerdict {
  // 没设额度 = 不限。这是绝大多数账号的状态,放在最前面短路。
  if (limitMicroUsd === undefined || limitMicroUsd === null) {
    return { allowed: true, usedMicroUsd };
  }

  /*
   * 【为什么是 >= 而不是 >】额度是"这个月最多花这么多"。
   * 用 > 的话,花费刚好等于上限时还能再发起一次运行 ——
   * 那次运行的花费会把总额顶到上限之上,等于每个账号都能多花一次。
   */
  if (usedMicroUsd >= limitMicroUsd) {
    return {
      allowed: false,
      reason: `本月用量已达上限(${formatUsd(usedMicroUsd)} / ${formatUsd(limitMicroUsd)}),请联系平台管理员调整额度`,
      usedMicroUsd,
      limitMicroUsd,
    };
  }

  return { allowed: true, usedMicroUsd, limitMicroUsd };
}
