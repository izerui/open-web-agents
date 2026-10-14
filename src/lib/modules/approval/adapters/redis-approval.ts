// 跨进程人工审批:待审请求存 Redis,裁决通过 pub/sub 通知等待方。
//
// 为什么不能用内存:agent 在 worker 进程里等待,裁决来自 web 进程的 HTTP 请求。
// 内存实现下 worker 永远收不到裁决 —— 表现为"点了批准但 agent 还在等"。

import {
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  ApprovalUnavailable,
  type SessionGrant,
} from "@/lib/modules/approval/ports";
import Redis from "ioredis";

const PENDING_KEY = (id: string) => `owa:approval:pending:${id}`;
const SESSION_SET = (sessionId: string) => `owa:approval:session:${sessionId}`;
const DECISION_CHANNEL = "owa:approval:decision";
/**
 * 裁决结果的落地副本。pub/sub 是"最多一次":订阅连接断开的那几秒里发出的裁决会直接丢,
 * 用户点了批准、运行却在 10 分钟后超时被拒。所以裁决先写一份到这个 key,
 * 等待方除了收消息,还定期来这里查一次 —— 消息丢了也能拿到结论。
 */
const DECISION_KEY = (id: string) => `owa:approval:decided:${id}`;
const DECISION_POLL_MS = 3_000;
const DECISION_TTL_MS = 15 * 60_000;

/**
 * 原子裁决:待审还在才落地裁决并删除待审,返回 1;待审已不存在(过期或已被别人裁决)返回 0。
 * 只用一条 EVAL(而非 EVALSHA + 回退),中间不存在"只做了一半"的状态。
 */
const RESOLVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'PX', tonumber(ARGV[2]))
redis.call('DEL', KEYS[1])
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[3], ARGV[3], ARGV[4])
  redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[5]))
end
return 1
`;

/** 会话级同类授权:field = 类别键,value = SessionGrant JSON */
const GRANTS_KEY = (sessionId: string) => `owa:approval:grants:${sessionId}`;
/** 授权随会话的活跃期续期;一周没再被授权就自然过期 */
const GRANTS_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * 原子收尾(到期时):已有裁决就返回它;否则删除待审,让之后的 resolve 一律落空,返回 nil。
 *
 * 【为什么超时也要原子】超时曾经直接判 expired:最后一次轮询之后、到期之前有人批准,
 * 而广播恰好丢了,已经落地的 approved 就被超时覆盖,随后 cleanup 连裁决一起删掉 ——
 * 审批人拿到了"批准成功",运行却按"超时拒绝"走了。"查裁决"和"关闭待审"必须是一步。
 */
const EXPIRE_SCRIPT = `
local decided = redis.call('GET', KEYS[2])
if decided then return decided end
redis.call('DEL', KEYS[1])
return false
`;

export interface RedisApprovalOptions {
  /** 兜底轮询裁决的间隔。 */
  pollMs?: number;
  /**
   * 单条 Redis 命令的等待上限。
   *
   * 【为什么需要】客户端配了 maxRetriesPerRequest: null —— 断网时命令进离线队列无限等待,
   * 既不返回也不抛错。到期收尾若卡在这里,等待方就永远不收尾,worker 被占到运行超时。
   */
  commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

export class RedisApproval implements ApprovalPort {
  private readonly cmd: Redis;
  private readonly sub: Redis;
  /** 本进程内正在等待裁决的请求 id → 兑现函数。 */
  private readonly waiters = new Map<string, (o: ApprovalOutcome) => void>();
  private readonly pollMs: number;
  private readonly commandTimeoutMs: number;

  constructor(redisUrl: string, opts: RedisApprovalOptions = {}) {
    this.pollMs = opts.pollMs ?? DECISION_POLL_MS;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
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
    await this.bounded(
      this.cmd
        .multi()
        .set(PENDING_KEY(req.id), JSON.stringify(req), "PX", ttlMs)
        .sadd(SESSION_SET(req.sessionId), req.id)
        .pexpire(SESSION_SET(req.sessionId), ttlMs + 60_000)
        .exec(),
      `无法登记审批 ${req.id}`,
    );

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      let settled = false;
      const stop = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(req.id);
        return true;
      };
      const finish = (outcome: ApprovalOutcome) => {
        if (!stop()) return;
        // 结论已确定(采用了裁决,或确认无裁决并关闭了待审),才清理 Redis 记录
        void this.cleanup(req);
        resolve(outcome);
      };
      /**
       * 无法确认结论。【不清理】—— 裁决可能已经落地,留给 TTL 回收;
       * 此刻去删,等于亲手销毁一份可能存在的批准记录。
       */
      const fail = (err: ApprovalUnavailable) => {
        if (!stop()) return;
        reject(err);
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

      // 到期收尾 —— 绝不让 worker 无限等人。但先原子地看一眼:到期前已落地的裁决必须采用
      const timer = setTimeout(() => {
        void this.closeExpired(req.id).then(finish, fail);
      }, ttlMs);
      // 兜底轮询:订阅消息丢了也能在几秒内拿到裁决
      const poll = setInterval(() => {
        void this.cmd
          .get(DECISION_KEY(req.id))
          .then((raw) => {
            if (raw) finish(JSON.parse(raw) as ApprovalOutcome);
          })
          .catch(() => {});
      }, this.pollMs);
      this.waiters.set(req.id, finish);
    });
  }

  /**
   * 到期时的原子收尾,见 EXPIRE_SCRIPT。
   *
   * Redis 出错或超时:抛 ApprovalUnavailable,【不】判 expired。批准可能在到期前早已落地,
   * 只是此刻读不到 —— 把"不知道"说成"没人批",审计记录就和审批人看到的相反。
   */
  private async closeExpired(id: string): Promise<ApprovalOutcome> {
    const decided = await this.bounded(
      this.cmd.eval(EXPIRE_SCRIPT, 2, PENDING_KEY(id), DECISION_KEY(id)),
      `到期时无法确认审批 ${id} 的裁决,已有裁决保留待过期回收`,
    );
    if (typeof decided === "string") return JSON.parse(decided) as ApprovalOutcome;
    return { decision: "expired" };
  }

  /** 给一条 Redis 命令加等待上限;出错或超时一律翻成 ApprovalUnavailable。 */
  private bounded<T>(p: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new ApprovalUnavailable(`${what}:Redis 在 ${this.commandTimeoutMs}ms 内无响应`)),
        this.commandTimeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(
            new ApprovalUnavailable(`${what}:${err instanceof Error ? err.message : String(err)}`),
          );
        },
      );
    });
  }

  /**
   * 裁决。"检查待审 → 落地裁决 → 删除待审"在一段 Lua 里原子完成,广播放在最后。
   *
   * 【为什么必须原子】曾经是 GETDEL 删掉待审,再单独 SET 裁决:两步之间进程退出或
   * Redis 请求失败,待审已经没了、裁决却没落地 —— 等待方轮询不到、广播也没发,
   * 只能等 10 分钟超时被拒,而审批人以为自己批准了。
   *
   * 【并发审批人】只有脚本里拿到待审的那一方返回 1,另一方明确得到"已被裁决"。
   * 曾经是 get → publish → del 三步,两个人几乎同时提交时都能收到"裁决生效",
   * 实际生效的取决于消息到达顺序。
   *
   * 【广播失败不算失败】裁决落地之后,它就已经生效了:等待方的轮询会读到它。
   * 此时再向调用方报错,只会让审批人以为没批成、再点一次,看到"已被裁决"一头雾水。
   */
  async resolve(
    id: string,
    outcome: ApprovalOutcome,
    remember?: { sessionId: string; grant: SessionGrant },
  ): Promise<boolean> {
    // 授权只跟批准一起落地,且在同一段脚本里:待审已失效(没批成)就不会留下授权
    const g = outcome.decision === "approved" ? remember : undefined;
    const won = await this.bounded(
      this.cmd.eval(
        RESOLVE_SCRIPT,
        3,
        PENDING_KEY(id),
        DECISION_KEY(id),
        GRANTS_KEY(g?.sessionId ?? "-"),
        JSON.stringify(outcome),
        String(DECISION_TTL_MS),
        g?.grant.key ?? "",
        g ? JSON.stringify(g.grant) : "",
        String(GRANTS_TTL_MS),
      ),
      `审批 ${id} 的裁决提交结果未知(连接恢复后可能仍会生效)`,
    );
    if (won !== 1) return false;
    // 广播同样要有上限:断网时它会进离线队列永不返回,把审批人的 HTTP 请求一直挂着。
    // 超时或失败都不影响结论 —— 裁决已经落地,等待方的轮询与到期收尾都能读到它
    await this.bounded(
      this.cmd.publish(DECISION_CHANNEL, JSON.stringify({ id, outcome })),
      `审批 ${id} 的裁决广播`,
    ).catch(() => {});
    return true;
  }

  async grants(sessionId: string): Promise<SessionGrant[]> {
    const raw = await this.bounded(
      this.cmd.hgetall(GRANTS_KEY(sessionId)),
      `无法读取会话 ${sessionId} 的同类授权`,
    );
    const out: SessionGrant[] = [];
    for (const v of Object.values(raw)) {
      try {
        out.push(JSON.parse(v) as SessionGrant);
      } catch {
        // 坏数据:跳过,不当成授权
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  async revokeGrant(sessionId: string, key: string): Promise<boolean> {
    const n = await this.bounded(
      this.cmd.hdel(GRANTS_KEY(sessionId), key),
      `撤销会话 ${sessionId} 的同类授权结果未知`,
    );
    return n > 0;
  }

  async listPending(sessionId: string): Promise<ApprovalRequest[]> {
    const ids = await this.bounded(
      this.cmd.smembers(SESSION_SET(sessionId)),
      `无法读取会话 ${sessionId} 的待审列表`,
    );
    if (ids.length === 0) return [];

    const raws = await this.bounded(
      this.cmd.mget(ids.map(PENDING_KEY)),
      `无法读取会话 ${sessionId} 的待审列表`,
    );
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
    // 顺手清理是附带动作:不等它,也不让它的失败影响这次读取
    if (stale.length) void this.cmd.srem(SESSION_SET(sessionId), ...stale).catch(() => {});

    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private async cleanup(req: ApprovalRequest): Promise<void> {
    await Promise.allSettled([
      this.cmd.del(PENDING_KEY(req.id)),
      this.cmd.del(DECISION_KEY(req.id)),
      this.cmd.srem(SESSION_SET(req.sessionId), req.id),
    ]);
  }

  async close(): Promise<void> {
    this.waiters.clear();
    await Promise.allSettled([this.cmd.quit(), this.sub.quit()]);
  }
}
