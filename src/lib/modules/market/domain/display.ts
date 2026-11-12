// 市场卡片与详情上的使用次数、每次约花费(gaps.md A10 / A11)。纯格式化,前后端都能用。

function grouped(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function trimZero(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** 近 90 天的使用次数:一万以上按「万」显示,保留一位小数。 */
export function formatUseCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "暂无使用";
  if (n < 10_000) return `${grouped(n)} 次使用`;
  return `${trimZero((n / 10_000).toFixed(1))} 万次使用`;
}

/**
 * 每次运行平均实扣的积分。null = 还没有可用的数据,界面改显示模型单价。
 * 精度随大小变:不足 1 积分保留两位,1–10 保留一位,10 以上取整。
 */
export function formatPerRun(credits: number | null | undefined): string | null {
  if (credits === null || credits === undefined || !Number.isFinite(credits)) return null;
  if (credits < 0.01) return "不到 0.01 积分/次";
  const text =
    credits < 1
      ? trimZero(credits.toFixed(2))
      : credits < 10
        ? trimZero(credits.toFixed(1))
        : grouped(credits);
  return `约 ${text} 积分/次`;
}
