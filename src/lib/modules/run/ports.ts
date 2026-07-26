import type { RunState } from "@/lib/shared";

export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  /** 租约到期时间戳(ms)。null = 未被认领或已完成。 */
  leaseUntil: number | null;
  /**
   * 栅栏令牌(fencing token):认领时拿到,后续写入必须带上。
   * 只有 claimNext 会返回它 —— 拿不到令牌就没资格写这一行。
   */
  fence?: string;
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
  /**
   * 续租,证明 worker 还活着。
   *
   * 返回 false = **本 worker 已失去租约**(租约超期后被回收、任务已被别人接手)。
   * 调用方必须立刻中止本轮 —— 继续跑就是同一任务被执行两次。
   * 这个返回值曾经是 void 且调用处 `.catch(() => {})`,于是失租无声无息。
   */
  touch(id: string, leaseUntil: number, fence?: string): Promise<boolean>;
  /**
   * 落终态。返回 false = 未写入(已失去租约,或该行已是终态)。
   *
   * 终态不可再迁移是状态机的规矩,但状态机只在内存里生效;
   * 真正的强制在这里 —— 写入边界不设防,规矩就只是注释。
   */
  complete(id: string, state: RunState, fence?: string): Promise<boolean>;
  /**
   * 取消尚未落终态的运行。返回 false = 它已经是终态了,取消无从谈起。
   *
   * 【这条曾经完全不存在】状态机里定义了 pending/running --cancel--> cancelled 两条边,
   * 但全仓找不到任何生产者:界面上的"停止"只调了 fetch 的 abort,
   * 而运行【不绑定在那个 HTTP 请求上】—— 服务端 agent 照常调模型、照常执行工具、
   * 照常扣费,直到 30 分钟墙钟上限或自然结束,最后落 success。
   * 用户以为停了,其实没停;cancelled 是个不可达状态。
   */
  cancel(id: string): Promise<boolean>;
  /** 把租约过期的 running 打回可认领,返回回收数量。 */
  reclaimOrphans(now: number): Promise<number>;
  get(id: string): Promise<Run | null>;
}
