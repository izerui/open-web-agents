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
  /** 仅 findByIdempotencyKey 返回:首次受理时的请求体摘要。 */
  idempotencyHash?: string;
  /**
   * 仅 findByIdempotencyKey 返回:首次受理时锁定的智能体版本(undefined = 草稿),
   * 以及那次的配置快照是否声明了 outputSchema(快照缺失的旧任务为 undefined)。
   * 重放必须如实回报【原任务】的版本与结果形态,而不是当前发布的版本。
   */
  agentVersion?: number;
  hasOutputSchema?: boolean;
}

export interface NewRun {
  id: string;
  sessionId: string;
  prompt?: string;
  parentRunId?: string;
  resumeAnchor?: string;
  /** 入队时的智能体配置快照,worker 按它执行。 */
  agentConfig?: unknown;
  /** 执行的智能体版本;不传 = 草稿。 */
  agentVersion?: number;
  /** 请求级凭证覆盖,已加密。 */
  overrideEnc?: string;
  /** 幂等键(已带调用方作用域)。重复则 create 抛 DuplicateIdempotencyKey。 */
  idempotencyKey?: string;
  idempotencyHash?: string;
}

/** create 撞上已存在的幂等键。调用方据此回滚自己刚建的会话,并返回已有的任务。 */
export class DuplicateIdempotencyKey extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`duplicate idempotency key: ${idempotencyKey}`);
    this.name = "DuplicateIdempotencyKey";
  }
}

/** 孤儿回收时写进 error 的类型标记 —— 结果接口与 webhook 都能据此识别。 */
export const WORKER_LOST = "worker_lost";

/** 队列 + 仓储。MySQL 乐观锁认领 + 租约续期 + 孤儿回收,零中间件的可靠异步任务。 */
export interface RunRepo {
  create(r: NewRun): Promise<Run>;
  /**
   * 认领一个可执行的 run。【只认领 pending】。
   *
   * 租约过期的 running 曾经也可认领(崩溃后由别的 worker 从头重跑)。但运行会产生
   * 外部副作用(MCP 调用、Bash 里的网络请求),栅栏令牌只挡得住重复写结果,
   * 挡不住重复执行 —— 重跑等于把副作用再做一遍,且 attempts 从未设上限,
   * 一个让 worker 崩溃的任务会被无限重跑。现在的语义是【至多一次】:
   * 失租的运行由 reclaimOrphans 判失败,要不要重试交给调用方决定。
   */
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
  /**
   * 把租约过期的 running 判为 failed(error.kind = worker_lost),返回本次判定的运行。
   * 多个 worker 同时回收时,每条运行只会出现在其中一个的返回值里 ——
   * 调用方据此发布终态事件,不会重复。
   */
  reclaimOrphans(now: number): Promise<Run[]>;
  get(id: string): Promise<Run | null>;
  /** 按幂等键找已受理的运行。 */
  findByIdempotencyKey(key: string): Promise<Run | null>;
  /**
   * 按会话聚合运行情况,供会话列表展示。
   *
   * 【为什么必须是批量】会话列表一次几十上百条,逐个会话查一次就是 N+1 ——
   * 列表页会随会话数线性变慢,这类查询正是拖垮列表接口的典型原因。
   *
   * 未出现在结果里的 sessionId = 该会话一轮都没跑过,调用方按 0 处理。
   */
  statsBySessions(sessionIds: string[]): Promise<Map<string, RunStats>>;
}

export interface RunStats {
  /** 该会话跑过的轮次总数(含失败与取消)。 */
  runs: number;
  /** 最后一次发起运行的时间戳(ms)。比会话创建时间更能反映"最近在用哪个"。 */
  lastRunAt: number;
}

/**
 * 取消通知:取消接口在数据库里标记 cancelled 之后发一条,正在执行该运行的 worker 立即中止。
 *
 * 【为什么需要】取消原本只靠 worker 的续租心跳发现(默认 15 秒一次):点了停止,
 * 工具还会继续执行最多 15 秒、继续花钱、继续产生副作用。
 * 通知是"尽力而为"(pub/sub 最多一次),丢了仍由心跳兜底 —— 正确性不依赖它,只是更快。
 */
export interface CancelSignal {
  publish(runId: string): Promise<void>;
  /** 订阅取消通知;返回取消订阅函数。 */
  subscribe(onCancel: (runId: string) => void): () => void;
}
