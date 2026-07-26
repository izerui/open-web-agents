// 跨进程人工审批:待审请求存 Redis,裁决通过 pub/sub 通知等待方。
//
// 为什么不能用内存:agent 在 worker 进程里等待,裁决来自 web 进程的 HTTP 请求。
// 内存实现下 worker 永远收不到裁决 —— 表现为"点了批准但 agent 还在等"。

import type { ApprovalOutcome, ApprovalPort, ApprovalRequest } from "@/lib/modules/approval/ports";
import Redis from "ioredis";

const PENDING_KEY = (id: string) => `owa:approval:pending:${id}`;
const SESSION_SET = (sessionId: string) => `owa:approval:session:${sessionId}`;
const DECISION_CHANNEL = "owa:approval:decision";

export class RedisApproval implements ApprovalPort {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  /** 本进程内正在等待裁决的请求 id → 兑现函数。 */
  private readonly waiters = new Map<string, (o: ApprovalOutcome) => void>();

  constructor(redisUrl: string) {
    this.cmd = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    // 无 error 监听 = Redis 抖动把错误 throw 成未捕获异常,直接杀进程。见 redis-bus.ts 同处。
    this.cmd.on("error", () => {});
    this.sub.on("error", () => {});

    // 这是裁决频道【唯一一次】订阅,失败后再也不重试:waiters 照常填充却永无消息到达,
    // 该进程内每一次审批都阻塞到 10 分钟超时后静默返回 expired ——
    // 用户点了批准却被拒,而 web 侧 resolve() 仍返回 true 报告成功,全链路无任何信号。
    // 故重连后必须重新订阅。
    const subscribe = () => {
      void this.sub.subscribe(DECISION_CHANNEL).catch(() => {});
    };
    subscribe();
    this.sub.on("ready", subscribe);
    this.sub.on("message", (_ch, payload) => {
      try {
        const { id, outcome } = JSON.parse(payload) as { id: string; outcome: ApprovalOutcome };
        this.waiters.get(id)?.(outcome);
      } catch {
        // 非本系统写入的脏数据,忽略
      }
    });
  }

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const ttlMs = Math.max(1000, req.expiresAt - Date.now());

    // 运行已经中止就别再挂上去了 —— 直接收场
    if (signal?.aborted) return { decision: "expired" };

    // 先落待审再等待:否则界面可能查不到这条请求(拿不到就没法批)
    await this.cmd.set(PENDING_KEY(req.id), JSON.stringify(req), "PX", ttlMs);
    await this.cmd.sadd(SESSION_SET(req.sessionId), req.id);
    await this.cmd.pexpire(SESSION_SET(req.sessionId), ttlMs + 60_000);

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(req.id);
        void this.cleanup(req);
        resolve(outcome);
      };
      /**
       * 运行被取消 / 超时中止时立刻收场。
       *
       * 少了这一条,等待就只由下面那个 10 分钟定时器驱动:运行早已结束,而
       * waiter、定时器、Redis 里的 pending key 全都还留着 —— 进程内按
       * 「被中止的运行数 × 10 分钟」持续累积。更要命的是界面上那条待审请求照常
       * 列出来,用户点批准还会收到 200「已裁决」:他为一个不存在的运行
       * 授权了一次危险操作,而审批记录与真实行为就此脱节。
       */
      const onAbort = () => finish({ decision: "expired" });
      signal?.addEventListener("abort", onAbort, { once: true });

      // 超时即拒 —— 绝不让 worker 无限等人
      const timer = setTimeout(() => finish({ decision: "expired" }), ttlMs);
      this.waiters.set(req.id, finish);
    });
  }

  /**
   * 裁决。用 GETDEL 把「取出」与「删除」做成一次原子操作。
   *
   * 曾经是 get → publish → del 三步:两个审批人几乎同时提交(一个批准一个拒绝)时
   * 都能读到非空、都广播、都收到 200「你的裁决生效了」,而实际生效的取决于
   * Redis 消息到达顺序。对「是否放行危险操作」这种语义,审计记录会与实际行为相反。
   * 现在只有拿到值的那一方才广播,另一方明确收到「已被裁决」。
   */
  async resolve(id: string, outcome: ApprovalOutcome): Promise<boolean> {
    const raw = await this.cmd.getdel(PENDING_KEY(id));
    if (!raw) return false;
    await this.cmd.publish(DECISION_CHANNEL, JSON.stringify({ id, outcome }));
    return true;
  }

  async listPending(sessionId: string): Promise<ApprovalRequest[]> {
    const ids = await this.cmd.smembers(SESSION_SET(sessionId));
    if (ids.length === 0) return [];

    const raws = await this.cmd.mget(ids.map(PENDING_KEY));
    const out: ApprovalRequest[] = [];
    const stale: string[] = [];

    for (const [i, raw] of raws.entries()) {
      const id = ids[i];
      if (!raw) {
        // key 已过期(或被裁决),顺手从会话集合里剔掉
        if (id) stale.push(id);
        continue;
      }
      try {
        out.push(JSON.parse(raw) as ApprovalRequest);
      } catch {
        if (id) stale.push(id);
      }
    }
    if (stale.length) await this.cmd.srem(SESSION_SET(sessionId), ...stale);

    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private async cleanup(req: ApprovalRequest): Promise<void> {
    await Promise.allSettled([
      this.cmd.del(PENDING_KEY(req.id)),
      this.cmd.srem(SESSION_SET(req.sessionId), req.id),
    ]);
  }

  async close(): Promise<void> {
    this.waiters.clear();
    await Promise.allSettled([this.cmd.quit(), this.sub.quit()]);
  }
}
