/**
 * 同一时刻最多一个在途:在途期间的调用都拿到同一个 Promise;它真正结束(兑现或拒绝)后才清空,
 * 下一次调用才会再发起。调用方自己的超时只是不再等,不会清掉在途的这一个 —— 所以底层不会积压。
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (!inflight) {
      const current = fn();
      inflight = current;
      const clear = () => {
        if (inflight === current) inflight = null;
      };
      current.then(clear, clear);
    }
    return inflight;
  };
}
