// 市场上每个智能体的作者、使用次数与每次平均花费(gaps.md A10 / A11)。

/** 使用次数统计最近多少天的运行 */
export const MARKET_USE_WINDOW_DAYS = 90;
/** 平均花费取最近多少次成功且已结算的运行 */
export const MARKET_AVG_SAMPLE = 50;

export interface MarketStats {
  /** 所有者的显示名:账号没有显示名,取邮箱 @ 前的部分;查不到为 null */
  author: string | null;
  /** 近 90 天的运行次数(不含评测与设计器会话) */
  useCount: number;
  /** 近 50 次成功运行的平均实扣积分;没有数据为 null */
  avgCredits: number | null;
}

export const EMPTY_MARKET_STATS: MarketStats = { author: null, useCount: 0, avgCredits: null };

/** 批量取统计:一次请求覆盖整页卡片,不按卡片逐个查。 */
export interface MarketStatsSource {
  forAgents(agents: readonly { id: string; ownerId: string }[]): Promise<Map<string, MarketStats>>;
}

export function authorOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0) return email;
  return at === 0 ? null : email.slice(0, at);
}

/** 数据库 AVG(decimal) 出来的是字符串;1 积分 = 1,000,000 微积分。 */
export function avgCreditsOf(avgMicro: string | number | null | undefined): number | null {
  if (avgMicro === null || avgMicro === undefined) return null;
  const n = typeof avgMicro === "number" ? avgMicro : Number(avgMicro);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}
