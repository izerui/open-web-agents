// 管理页页签与地址 ?tab= 同步的纯逻辑(书签、旧地址重定向都靠它落到对的页签)。

/** 地址里的 tab 合法就用它,否则用默认页签 */
export function tabFrom<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * 切换页签后的地址:只改 tab,其余参数(如运行记录的 ?agent=)原样保留;
 * 切回默认页签时去掉 tab,让地址保持干净。
 */
export function hrefWithTab(
  pathname: string,
  search: string | URLSearchParams,
  tab: string,
  fallback: string,
): string {
  const q = new URLSearchParams(search);
  if (tab === fallback) q.delete("tab");
  else q.set("tab", tab);
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}
