/**
 * 全站统一的时间显示:同一年 `MM-DD HH:mm`,跨年 `YYYY-MM-DD HH:mm`,按浏览器所在时区。
 * 不用 toLocaleString —— 它跟浏览器语言走,英文环境下会变成 11/12/2026, 11:56 PM。
 */
export function formatTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}
