const p2 = (n: number) => String(n).padStart(2, "0");

function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 列表里的短时间(本地时区):今天「14:32」、昨天「昨天 18:22」、今年「10-02 09:14」、往年「2025-12-31」。
 * 完整时间放在 title 里,列表只留能扫读的部分。
 */
export function shortTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const today = dayStart(now);
  if (ms >= today) return hm;
  // 用前一天的 0 点比较,夏令时的 23/25 小时日也对
  const yesterday = dayStart(today - 1);
  if (ms >= yesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
  }
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
