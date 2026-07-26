import type { RunState } from "@/lib/shared";

export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  /** 租约到期时间戳(ms)。null = 未被认领或已完成。 */
  leaseUntil: number | null;
}

export interface NewRun {
  id: string;
  sessionId: string;
}

/** 队列 + 仓储。MySQL 乐观锁认领 + 租约续期 + 孤儿回收,零中间件的可靠异步任务。 */
export interface RunRepo {
  create(r: NewRun): Promise<Run>;
  /** 认领一个可执行的 run(pending,或 running 但租约已过期)。 */
  claimNext(leaseMs: number, now: number): Promise<Run | null>;
  /** 续租,证明 worker 还活着。 */
  touch(id: string, leaseUntil: number): Promise<void>;
  complete(id: string, state: RunState): Promise<void>;
  /** 把租约过期的 running 打回可认领,返回回收数量。 */
  reclaimOrphans(now: number): Promise<number>;
  get(id: string): Promise<Run | null>;
}
