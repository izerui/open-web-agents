// MySQL 当队列的 RunRepo 实现:乐观锁认领 + 租约续期 + 孤儿回收,零中间件。
//
// 认领的正确性关键:UPDATE 必须把"筛选条件"和"占位"放在同一条语句里,
// 靠 MySQL 的行锁保证原子性 —— 先 SELECT 再 UPDATE 会在并发下把同一个 run 发给两个 worker。

import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import type { RunRecord } from "@/lib/modules/run/domain/run-result";
import {
  type CallbackSnapshot,
  DuplicateIdempotencyKey,
  type NewRun,
  type Run,
  type RunRepo,
  type RunStats,
  WORKER_LOST,
} from "@/lib/modules/run/ports";
import type { RunState } from "@/lib/shared";
import { and, count, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

interface RunRow {
  id: string;
  sessionId: string;
  status: string;
  leaseUntil: number | null;
}

/**
 * 取受影响行数。
 *
 * drizzle 的 mysql2 driver 返回 `[ResultSetHeader, FieldPacket[]]` —— affectedRows 在 res[0] 上,
 * 不在顶层。直接读顶层会永远拿到 undefined,让"认领成功"判定恒为假(队列彻底不工作)。
 */
function affectedRows(res: unknown): number {
  if (Array.isArray(res)) {
    return (res[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  }
  return (res as { affectedRows?: number } | null)?.affectedRows ?? 0;
}

/**
 * 栅栏条件。不传令牌时退化为「不校验」—— 契约测试与内存 fake 里有大量
 * 不关心并发的直接调用,强制传令牌会把它们全逼成噪音。
 * 生产路径(worker)一律传,由 worker 侧的测试守住。
 */
function fenceOf(fence?: string) {
  return fence ? [eq(runs.leaseOwner, fence)] : [];
}

/** 撞上唯一索引 uniq_runs_idempotency。mysql2 的错误可能被 drizzle 包一层,cause 里才是原始错误。 */
function isDuplicateIdempotency(err: unknown): boolean {
  for (let e = err as { code?: string; message?: string; cause?: unknown } | undefined; e; ) {
    if (e.code === "ER_DUP_ENTRY" && /uniq_runs_idempotency/.test(e.message ?? "")) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * 终态时同一条 UPDATE 里登记回调发件箱。
 * 不在这里判断智能体有没有配 webhook —— RunRepo 不依赖 agents/sessions 表,
 * 投递器取到后发现没配就标 skipped。
 */
const WEBHOOK_PENDING = { webhookState: "pending", webhookNextAt: 0 } as const;

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.sessionId,
    state: row.status as RunState,
    leaseUntil: row.leaseUntil === null ? null : Number(row.leaseUntil),
  };
}

export class MysqlRunRepo implements RunRepo {
  constructor(private readonly db: Db) {}

  async create(r: NewRun): Promise<Run> {
    try {
      await this.db.insert(runs).values({
        id: r.id,
        sessionId: r.sessionId,
        status: "pending",
        prompt: r.prompt ?? "",
        parentRunId: r.parentRunId,
        resumeAnchor: r.resumeAnchor,
        agentConfig: r.agentConfig ?? null,
        agentVersion: r.agentVersion ?? null,
        overrideEnc: r.overrideEnc,
        callbackSource: r.callback?.source,
        callbackUrl: r.callback && r.callback.source !== "none" ? r.callback.url : undefined,
        idempotencyKey: r.idempotencyKey,
        idempotencyHash: r.idempotencyHash,
        leaseUntil: null,
      });
    } catch (err) {
      if (r.idempotencyKey && isDuplicateIdempotency(err)) {
        throw new DuplicateIdempotencyKey(r.idempotencyKey);
      }
      throw err;
    }
    return { id: r.id, sessionId: r.sessionId, state: "pending", leaseUntil: null };
  }

  async findByIdempotencyKey(key: string): Promise<Run | null> {
    const rows = await this.db
      .select({
        id: runs.id,
        sessionId: runs.sessionId,
        status: runs.status,
        leaseUntil: runs.leaseUntil,
        idempotencyHash: runs.idempotencyHash,
        agentVersion: runs.agentVersion,
        agentConfig: runs.agentConfig,
      })
      .from(runs)
      .where(eq(runs.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const cfg = row.agentConfig as { outputSchema?: unknown } | null;
    return {
      ...toRun(row),
      idempotencyHash: row.idempotencyHash ?? undefined,
      agentVersion: row.agentVersion ?? undefined,
      hasOutputSchema: cfg
        ? cfg.outputSchema !== undefined && cfg.outputSchema !== null
        : undefined,
    };
  }

  /**
   * 认领一个可执行的 run:只认领 pending(至多一次语义,见 RunRepo.claimNext)。
   *
   * 单条 UPDATE 直接占位 —— 条件里带上认领前的状态,MySQL 行锁保证并发下只有一个 worker
   * 能把某一行从"可认领"改成"已占"。affectedRows=0 表示被别人抢先,重试下一个。
   */
  async claimNext(leaseMs: number, now: number): Promise<Run | null> {
    const claimable = eq(runs.status, "pending");
    const sessionIdle = sql`NOT EXISTS (
      SELECT 1 FROM runs active
      WHERE active.session_id = ${runs.sessionId}
        AND active.status = 'running'
        AND active.lease_until >= ${now}
    )`;

    // 多 worker 下同一候选可能被抢,重试几次再放弃
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidates = await this.db
        .select({ id: runs.id, sessionId: runs.sessionId })
        .from(runs)
        .where(and(claimable, sessionIdle))
        .orderBy(runs.createdAt)
        .limit(1);

      const candidate = candidates[0];
      if (!candidate) return null;

      const claimed = await this.db.transaction(async (tx) => {
        // 以该会话最早的 run 行作为跨 worker 互斥锁。RunRepo 因此不依赖 sessions 表
        // 的生命周期;不同会话锁不同的行,同一会话的认领事务则在这里排队。
        await tx.execute(sql`
          SELECT id FROM runs
          WHERE session_id = ${candidate.sessionId}
          ORDER BY created_at, id
          LIMIT 1 FOR UPDATE
        `);

        const active = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.sessionId, candidate.sessionId),
              eq(runs.status, "running"),
              gte(runs.leaseUntil, now),
              ne(runs.id, candidate.id),
            ),
          )
          .limit(1);
        if (active.length > 0) return null;

        const fence = randomUUID();
        const res = await tx
          .update(runs)
          .set({
            status: "running",
            leaseUntil: now + leaseMs,
            leaseOwner: fence,
            startedAt: sql`COALESCE(${runs.startedAt}, NOW())`,
            attempts: sql`${runs.attempts} + 1`,
          })
          .where(and(eq(runs.id, candidate.id), claimable));

        if (affectedRows(res) === 0) return null;
        return {
          id: candidate.id,
          sessionId: candidate.sessionId,
          state: "running" as const,
          leaseUntil: now + leaseMs,
          fence,
        };
      });

      if (claimed) return claimed;
      // 候选被其它 worker 抢走或同会话已有运行,换下一个候选。
    }
    return null;
  }

  /**
   * 续租。affectedRows=0 意味着这一行已经不归本 worker 管了 ——
   * 要么租约超期被回收、要么已被别人接手完成。返回 false 让调用方立刻收手。
   */
  async touch(id: string, leaseUntil: number, fence?: string): Promise<boolean> {
    const res = await this.db
      .update(runs)
      .set({ leaseUntil })
      .where(and(eq(runs.id, id), eq(runs.status, "running"), ...fenceOf(fence)));
    return affectedRows(res) > 0;
  }

  /**
   * 落终态。两道守卫:
   * - `status = running` —— 终态不可再迁移。没有这条,一个被判定为孤儿的僵尸 worker
   *   跑完后能把别人写好的 success 覆写成 failed,或把 cancelled 翻回 success。
   * - 栅栏令牌 —— 即使状态还是 running,也只有当前持有租约的 worker 有资格写。
   */
  async complete(id: string, state: RunState, fence?: string): Promise<boolean> {
    const res = await this.db
      .update(runs)
      .set({
        status: state,
        leaseUntil: null,
        leaseOwner: null,
        endedAt: sql`NOW()`,
        ...WEBHOOK_PENDING,
      })
      .where(and(eq(runs.id, id), eq(runs.status, "running"), ...fenceOf(fence)));
    return affectedRows(res) > 0;
  }

  /**
   * 取消一个尚未落终态的运行。
   *
   * 【为什么只是一条 UPDATE 就够了】—— 它复用了栅栏机制:worker 的续租要求
   * `status = running` 且令牌匹配,这里把状态改成 cancelled 之后,下一次心跳
   * 立刻返回 false,worker 据此 abort 本轮、且不写回任何结果。
   * 不需要额外的跨进程控制通道。
   *
   * 代价是取消的生效延迟最多一个心跳周期(默认 15 秒)—— 这是如实的:
   * 界面上不该在点下去的瞬间就宣称"已停止"。
   */
  async cancel(id: string): Promise<boolean> {
    const res = await this.db
      .update(runs)
      .set({
        status: "cancelled",
        leaseUntil: null,
        leaseOwner: null,
        endedAt: sql`NOW()`,
        ...WEBHOOK_PENDING,
      })
      .where(and(eq(runs.id, id), inArray(runs.status, ["pending", "running"])));
    return affectedRows(res) > 0;
  }

  /**
   * 把租约过期的 running 判为 failed(worker_lost)。
   *
   * 逐行 UPDATE 而不是一条批量 UPDATE:多个 worker 同时回收时,批量写法只知道
   * "改了几行"、不知道是哪几行,于是没法保证每条运行的失败事件恰好发一次。
   * 逐行带条件更新,affectedRows=1 的那一方才是这一行的回收者。
   */
  async reclaimOrphans(now: number): Promise<Run[]> {
    const candidates = await this.db
      .select({ id: runs.id, sessionId: runs.sessionId })
      .from(runs)
      .where(and(eq(runs.status, "running"), lt(runs.leaseUntil, now)))
      .limit(200);

    const reclaimed: Run[] = [];
    for (const c of candidates) {
      const res = await this.db
        .update(runs)
        .set({
          status: "failed",
          leaseUntil: null,
          leaseOwner: null,
          endedAt: sql`NOW()`,
          errorInfo: {
            kind: WORKER_LOST,
            message: "执行该运行的 worker 失去响应(崩溃或被强制停止),运行已中止且不会自动重跑",
          },
          ...WEBHOOK_PENDING,
        })
        .where(and(eq(runs.id, c.id), eq(runs.status, "running"), lt(runs.leaseUntil, now)));
      if (affectedRows(res) > 0) {
        reclaimed.push({ id: c.id, sessionId: c.sessionId, state: "failed", leaseUntil: null });
      }
    }
    return reclaimed;
  }

  async get(id: string): Promise<Run | null> {
    const rows = await this.db
      .select({
        id: runs.id,
        sessionId: runs.sessionId,
        status: runs.status,
        leaseUntil: runs.leaseUntil,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toRun(row) : null;
  }

  /** 取待执行的载荷(worker 认领后需要):输入、配置快照、加密的请求级覆盖。 */
  async getPayload(
    id: string,
  ): Promise<{ prompt: string; agentConfig?: unknown; overrideEnc?: string } | null> {
    const rows = await this.db
      .select({
        prompt: runs.prompt,
        agentConfig: runs.agentConfig,
        overrideEnc: runs.overrideEnc,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      prompt: row.prompt,
      agentConfig: row.agentConfig ?? undefined,
      overrideEnc: row.overrideEnc ?? undefined,
    };
  }

  // ─────────────── 回调发件箱(WebhookOutbox 端口,见 integration 模块) ───────────────

  /**
   * 认领一条到期的待投递回调。投递中的行把 webhook_next_at 当租约用:
   * 投递进程崩了,租约过期后会被重新认领 —— 回调因此是【至少一次】,
   * 接收方按 deliveryId 去重(这与运行本身的至多一次不矛盾:重发通知无副作用)。
   */
  async claimWebhook(
    now: number,
    leaseMs: number,
  ): Promise<{
    runId: string;
    sessionId: string;
    attempts: number;
    lease: string;
    callback?: CallbackSnapshot;
  } | null> {
    const due = or(
      and(eq(runs.webhookState, "pending"), lte(runs.webhookNextAt, now)),
      and(eq(runs.webhookState, "delivering"), lt(runs.webhookNextAt, now)),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.db
        .select({
          id: runs.id,
          sessionId: runs.sessionId,
          attempts: runs.webhookAttempts,
          state: runs.webhookState,
          nextAt: runs.webhookNextAt,
          callbackUrl: runs.callbackUrl,
          callbackSource: runs.callbackSource,
        })
        .from(runs)
        .where(due)
        .orderBy(runs.webhookNextAt)
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      // 条件里带上读到的旧值:被别人抢先改过就 affectedRows=0,换下一条
      const lease = randomUUID();
      const res = await this.db
        .update(runs)
        .set({
          webhookState: "delivering",
          webhookNextAt: now + leaseMs,
          webhookAttempts: sql`${runs.webhookAttempts} + 1`,
          webhookLease: lease,
        })
        .where(
          and(
            eq(runs.id, row.id),
            eq(runs.webhookState, row.state ?? ""),
            eq(runs.webhookNextAt, Number(row.nextAt ?? 0)),
          ),
        );
      if (affectedRows(res) > 0) {
        return {
          runId: row.id,
          sessionId: row.sessionId,
          attempts: row.attempts + 1,
          lease,
          callback: toCallbackSnapshot(row.callbackSource, row.callbackUrl),
        };
      }
    }
    return null;
  }

  /** 记下投递结局。retry 时 nextAt 是下一次可投递的时刻。 */
  async markWebhook(
    runId: string,
    lease: string,
    state: "delivered" | "failed" | "skipped" | "pending",
    nextAt?: number,
  ): Promise<boolean> {
    const res = await this.db
      .update(runs)
      .set({
        webhookState: state,
        webhookNextAt: state === "pending" ? (nextAt ?? 0) : null,
        // 结局已定,令牌作废;pending 时下一次认领会换新令牌
        webhookLease: null,
      })
      .where(
        and(eq(runs.id, runId), eq(runs.webhookState, "delivering"), eq(runs.webhookLease, lease)),
      );
    return affectedRows(res) > 0;
  }

  async requeueWebhook(runId: string, now: number): Promise<boolean> {
    const res = await this.db
      .update(runs)
      // 清掉旧令牌:还卡在路上的旧投递,结果再也写不回来
      .set({ webhookState: "pending", webhookNextAt: now, webhookAttempts: 0, webhookLease: null })
      .where(
        and(eq(runs.id, runId), inArray(runs.webhookState, ["delivered", "failed", "skipped"])),
      );
    return affectedRows(res) > 0;
  }

  /**
   * 取这一轮该用的 resume 锚点。
   * 返回 { anchored: true } 表示该运行有自己的锚点意图(含"首轮从零开始"),
   * 上层就不该再回退到会话的最新锚点 —— 否则分支会串回主线。
   */
  async getResumeAnchor(id: string): Promise<{ anchored: boolean; anchor?: string }> {
    const rows = await this.db
      .select({ anchor: runs.resumeAnchor, parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return { anchored: false };
    // 有父运行 = 这是分支,它的锚点意图是明确的(哪怕锚点为空表示从零重开)
    if (row.parentRunId) return { anchored: true, anchor: row.anchor ?? undefined };
    return row.anchor ? { anchored: true, anchor: row.anchor } : { anchored: false };
  }

  /** 记录这一轮【实际使用】的起跑锚点,供审计"这轮从哪儿起跑"。 */
  async setResumeAnchor(id: string, anchor: string | null): Promise<void> {
    await this.db.update(runs).set({ resumeAnchor: anchor }).where(eq(runs.id, id));
  }

  /** 记录这一轮跑完产生的 SDK 会话(供后续轮次与分支续接)及本轮在 transcript 里的范围。 */
  async setSdkSessionId(
    id: string,
    sdkSessionId: string,
    range?: { first: string; last: string },
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({
        sdkSessionId,
        ...(range ? { transcriptFirstUuid: range.first, transcriptLastUuid: range.last } : {}),
      })
      .where(eq(runs.id, id));
  }

  /** 列出会话内的运行,含分支信息,供界面画分支树。 */
  async listBySession(sessionId: string): Promise<
    {
      id: string;
      status: RunState;
      prompt: string;
      parentRunId?: string;
      resumeAnchor?: string;
      sdkSessionId?: string;
      transcriptRange?: { first: string; last: string };
      createdAt: number;
    }[]
  > {
    const rows = await this.db
      .select({
        id: runs.id,
        status: runs.status,
        prompt: runs.prompt,
        parentRunId: runs.parentRunId,
        resumeAnchor: runs.resumeAnchor,
        sdkSessionId: runs.sdkSessionId,
        transcriptFirstUuid: runs.transcriptFirstUuid,
        transcriptLastUuid: runs.transcriptLastUuid,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(runs.createdAt)
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      status: r.status as RunState,
      prompt: r.prompt,
      parentRunId: r.parentRunId ?? undefined,
      resumeAnchor: r.resumeAnchor ?? undefined,
      sdkSessionId: r.sdkSessionId ?? undefined,
      transcriptRange:
        r.transcriptFirstUuid && r.transcriptLastUuid
          ? { first: r.transcriptFirstUuid, last: r.transcriptLastUuid }
          : undefined,
      createdAt: r.createdAt.getTime(),
    }));
  }

  /** 补记花费:只在还没有花费记录时写入(不覆盖结算过的数据),见 RunPayloadSource.recordCost。 */
  async recordCost(id: string, cost: unknown): Promise<void> {
    await this.db
      .update(runs)
      .set({ cost })
      .where(and(eq(runs.id, id), isNull(runs.cost)));
  }

  /** 记录终态结果,供轮询接口读取。 */
  async saveResult(
    id: string,
    data: {
      finalText?: string;
      structured?: unknown;
      salvaged?: boolean;
      cost?: unknown;
      error?: unknown;
    },
    fence?: string,
  ): Promise<void> {
    // 【只写传进来的字段】。曾经是无条件 `?? null` 三连,于是异常路径调用
    // saveResult({error}) 会把上一步刚落库的 structured 与 cost 一起抹成 null ——
    // 一次真正成功、结果已在库里的运行,数据被销毁而不只是被误标。
    const patch: Record<string, unknown> = {};
    if ("finalText" in data) patch.finalText = data.finalText ?? null;
    if ("structured" in data) patch.structuredResult = data.structured ?? null;
    if ("salvaged" in data) patch.structuredSalvaged = data.salvaged ? 1 : 0;
    if ("cost" in data) patch.cost = data.cost ?? null;
    if ("error" in data) patch.errorInfo = data.error ?? null;
    if (Object.keys(patch).length === 0) return;

    await this.db
      .update(runs)
      .set(patch)
      .where(and(eq(runs.id, id), ...fenceOf(fence)));
  }

  /** 取完整运行状态与结果(对外结果契约的数据源,见 run/domain/run-result.ts)。 */
  async getResult(id: string): Promise<RunRecord | null> {
    const rows = await this.db
      .select({
        id: runs.id,
        status: runs.status,
        structured: runs.structuredResult,
        salvaged: runs.structuredSalvaged,
        finalText: runs.finalText,
        cost: runs.cost,
        error: runs.errorInfo,
        agentVersion: runs.agentVersion,
        startedAt: runs.startedAt,
        endedAt: runs.endedAt,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      status: row.status as RunState,
      salvaged: row.salvaged === null ? null : row.salvaged === 1,
    };
  }

  /**
   * 列出各会话的活动信息,供工作空间 GC 判定。
   * finished = 该会话没有任何未完成的 run。
   */
  async listSessionActivity(): Promise<
    { sessionId: string; lastActiveAt: number; finished: boolean }[]
  > {
    const rows = await this.db.execute(sql`
      SELECT s.id AS sessionId,
             GREATEST(
               UNIX_TIMESTAMP(s.created_at) * 1000,
               COALESCE(MAX(UNIX_TIMESTAMP(COALESCE(r.ended_at, r.created_at)) * 1000), 0),
               -- 上传文件、运行启动也算活动(工作目录协议在会话行锁内记下的)
               COALESCE(s.workspace_touched_at, 0)
             ) AS lastActiveAt,
             SUM(CASE WHEN r.status IN ('pending','running') THEN 1 ELSE 0 END) AS openRuns
      FROM sessions s
      LEFT JOIN runs r ON r.session_id = s.id
      GROUP BY s.id, s.created_at, s.workspace_touched_at
    `);
    const list = (Array.isArray(rows) ? rows[0] : rows) as unknown as Array<{
      sessionId: string;
      lastActiveAt: string | number;
      openRuns: string | number | null;
    }>;
    return (list ?? []).map((r) => ({
      sessionId: r.sessionId,
      lastActiveAt: Number(r.lastActiveAt),
      finished: Number(r.openRuns ?? 0) === 0,
    }));
  }

  async statsBySessions(sessionIds: string[]): Promise<Map<string, RunStats>> {
    const out = new Map<string, RunStats>();
    // inArray 传空数组会生成 `in ()` —— MySQL 语法错误,直接短路
    if (sessionIds.length === 0) return out;

    // 一条 GROUP BY 顶掉 N 次查询;runs 表上有 idx_runs_session,按会话分组走索引
    const rows = await this.db
      .select({
        sessionId: runs.sessionId,
        total: count(),
        // 聚合 timestamp 经 Drizzle/mysql2 解码时会受进程时区影响;直接取 Unix 毫秒
        // 可避免 Asia/Shanghai 等环境下把 lastRunAt 重复偏移一次。
        lastRunAt: sql<number>`MAX(UNIX_TIMESTAMP(${runs.createdAt}) * 1000)`,
      })
      .from(runs)
      .where(inArray(runs.sessionId, [...new Set(sessionIds)]))
      .groupBy(runs.sessionId);

    for (const r of rows) {
      const at = Number(r.lastRunAt ?? 0);
      out.set(r.sessionId, { runs: Number(r.total), lastRunAt: Number.isFinite(at) ? at : 0 });
    }
    return out;
  }

  /**
   * 仅测试用:清空队列。
   *
   * 【危险操作,必须显式确认】曾经把 OWA_TEST_DATABASE_URL 指到开发库上跑测试,
   * 这一句直接把开发数据删了。故要求调用方传入库名并自证是测试库 ——
   * 让"误删开发数据"从"注意点"变成"做不到"。
   */
  async _truncate(confirmTestDatabase: string): Promise<void> {
    if (!/test/i.test(confirmTestDatabase)) {
      throw new Error(
        `拒绝清空非测试库:${confirmTestDatabase} —— 库名须含 "test"(把 OWA_TEST_DATABASE_URL 指向专用测试库)`,
      );
    }
    await this.db.delete(runs).where(sql`1=1`);
  }
}

/** 行上的快照两列 → 快照;NULL 来源是快照功能之前的旧行。来源与地址对不上的行按没有快照处理。 */
function toCallbackSnapshot(
  source: string | null,
  url: string | null,
): CallbackSnapshot | undefined {
  if (source === "none") return { source: "none" };
  if ((source === "agent" || source === "caller") && url) return { source, url };
  return undefined;
}
