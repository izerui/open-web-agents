// 用量分析的展示计算:纯函数,便于测试。

/** 按智能体横条:total 是条长(占最大值的 %),ok / failed 是条内两段的占比 */
export function barWidths(
  b: { runs: number; failed: number },
  max: number,
): { total: number; ok: number; failed: number } {
  if (max <= 0 || b.runs <= 0) return { total: 0, ok: 0, failed: 0 };
  const total = Math.max(2, Math.round((b.runs / max) * 100));
  const failed = Math.round((b.failed / b.runs) * 100);
  return { total, ok: 100 - failed, failed };
}

/** 成功率(%),一位小数;没有运行返回 null */
export function successRate(t: { runs: number; succeeded: number }): number | null {
  if (t.runs <= 0) return null;
  return Math.round((t.succeeded / t.runs) * 1000) / 10;
}

/** 柱状图横轴只标首、中、末三个日期 */
export function dayTicks<T>(days: readonly T[]): T[] {
  if (days.length < 3) return [...days];
  return [days[0] as T, days[Math.floor((days.length - 1) / 2)] as T, days[days.length - 1] as T];
}

/** 按天统计只返回有运行的日子;柱状图要每天一根,没有的补 0(UTC 日期,与接口一致) */
export function fillDays<T extends { key: string; runs: number; failed: number }>(
  byDay: readonly T[],
  days: number,
  now: number,
): { key: string; runs: number; failed: number }[] {
  const n = Math.max(2, days);
  const have = new Map(byDay.map((d) => [d.key, d]));
  const out: { key: string; runs: number; failed: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const d = have.get(key);
    out.push({ key, runs: d?.runs ?? 0, failed: d?.failed ?? 0 });
  }
  return out;
}

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** 平台用量「队列（实时）」卡:排队超过 10 个黄色提醒 */
export function queueStatus(q: { pending: number; running: number }): {
  warn: boolean;
  text: string;
} {
  return q.pending > 10
    ? { warn: true, text: "排队超过 10 个，考虑加 worker" }
    : { warn: false, text: "队列正常" };
}
