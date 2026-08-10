/**
 * 带错误处理的 JSON 请求。
 *
 * 【为什么要有这个】直接写 `fetch(url).then(r => r.json())` 有两个坑,
 * 而且这两个坑真的把界面搞崩过一次:
 *
 * 1. **不看 res.ok** —— 接口 500 时响应体往往是空的,`json()` 抛 SyntaxError。
 *    调用方 catch 的是一个"JSON 解析失败",完全看不出是后端挂了。
 * 2. **一条链挂掉带走一片** —— 多个请求写在同一个 async 函数里顺序 await,
 *    第一个抛错后面全不执行,界面上表现为"数据全没了",屏幕上却没有任何线索。
 *
 * 服务端的错误体统一是 `{ error: string }`,这里优先把那句话抛出来 ——
 * "login required" 比 "HTTP 401" 对排查有用得多。
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);

  if (!res.ok) {
    // 错误体可能不是 JSON(网关返回 HTML、或干脆是空的),读不出来就退回状态码
    const detail = await res
      .json()
      .then((b: unknown) => (b as { error?: string } | null)?.error)
      .catch(() => undefined);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}

/** 取错误的可读文案 —— catch 到的东西不一定是 Error。 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
