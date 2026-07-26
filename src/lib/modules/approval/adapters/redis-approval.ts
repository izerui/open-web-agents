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

    void this.sub.subscribe(DECISION_CHANNEL).catch(() => {});
    this.sub.on("message", (_ch, payload) => {
      try {
        const { id, outcome } = JSON.parse(payload) as { id: string; outcome: ApprovalOutcome };
        this.waiters.get(id)?.(outcome);
      } catch {
        // 非本系统写入的脏数据,忽略
      }
    });
  }

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const ttlMs = Math.max(1000, req.expiresAt - Date.now());

    // 先落待审再等待:否则界面可能查不到这条请求(拿不到就没法批)
    await this.cmd.set(PENDING_KEY(req.id), JSON.stringify(req), "PX", ttlMs);
    await this.cmd.sadd(SESSION_SET(req.sessionId), req.id);
    await this.cmd.pexpire(SESSION_SET(req.sessionId), ttlMs + 60_000);

    return new Promise<ApprovalOutcome>((resolve) => {
      const finish = (outcome: ApprovalOutcome) => {
        clearTimeout(timer);
        this.waiters.delete(req.id);
        void this.cleanup(req);
        resolve(outcome);
      };
      // 超时即拒 —— 绝不让 worker 无限等人
      const timer = setTimeout(() => finish({ decision: "expired" }), ttlMs);
      this.waiters.set(req.id, finish);
    });
  }

  async resolve(id: string, outcome: ApprovalOutcome): Promise<boolean> {
    // 请求已过期或不存在时不广播 —— 避免让等待方收到一个它已放弃的裁决
    const raw = await this.cmd.get(PENDING_KEY(id));
    if (!raw) return false;
    await this.cmd.publish(DECISION_CHANNEL, JSON.stringify({ id, outcome }));
    await this.cmd.del(PENDING_KEY(id));
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
