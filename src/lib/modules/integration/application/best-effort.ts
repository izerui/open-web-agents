// 投递记录的"尽力写入":有等待上限、永不抛错。
//
// 投递记录是给人排查用的旁路信息,不能反过来影响投递本身 ——
// 写失败不能把一次成功的投递变成 500,数据库不返回也不能让投递器或 HTTP 请求一直挂着。
// 【超时只是不再等】底层的 INSERT 并没有被取消,之后仍可能落库(或失败)。

export const RECORD_TIMEOUT_MS = 2000;

export async function recordBestEffort(
  write: () => Promise<void>,
  opts: { timeoutMs?: number; onError?: (err: unknown) => void } = {},
): Promise<void> {
  const ms = opts.timeoutMs ?? RECORD_TIMEOUT_MS;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        t = setTimeout(
          () => reject(new Error(`投递记录写入超过 ${ms}ms 未完成,已放弃等待(底层写入未取消)`)),
          ms,
        );
      }),
    ]);
  } catch (err) {
    (opts.onError ?? ((e) => console.warn("[owa][webhook] 投递记录写入失败:", e)))(err);
  } finally {
    clearTimeout(t);
  }
}
