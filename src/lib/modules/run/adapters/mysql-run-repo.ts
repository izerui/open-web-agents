// MySQL 当队列的 RunRepo 实现:乐观锁认领 + 租约续期 + 孤儿回收,零中间件。
//
// 认领的正确性关键:UPDATE 必须把"筛选条件"和"占位"放在同一条语句里,
// 靠 MySQL 的行锁保证原子性 —— 先 SELECT 再 UPDATE 会在并发下把同一个 run 发给两个 worker。

import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import type { NewRun, Run, RunRepo } from "@/lib/modules/run/ports";
import type { RunState } from "@/lib/shared";
import { and, eq, lt, or, sql } from "drizzle-orm";

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

  async create(
    r: NewRun & { prompt?: string; parentRunId?: string; resumeAnchor?: string },
  ): Promise<Run> {
    await this.db.insert(runs).values({
      id: r.id,
      sessionId: r.sessionId,
      status: "pending",
      prompt: r.prompt ?? "",
      parentRunId: r.parentRunId,
      resumeAnchor: r.resumeAnchor,
      leaseUntil: null,
    });
    return { id: r.id, sessionId: r.sessionId, state: "pending", leaseUntil: null };
  }

  /**
   * 认领一个可执行的 run:pending,或 running 但租约已过期(worker 崩了)。
   *
   * 单条 UPDATE 直接占位 —— 条件里带上认领前的状态,MySQL 行锁保证并发下只有一个 worker
   * 能把某一行从"可认领"改成"已占"。affectedRows=0 表示被别人抢先,重试下一个。
   */
  async claimNext(leaseMs: number, now: number): Promise<Run | null> {
    const claimable = or(
      eq(runs.status, "pending"),
      and(eq(runs.status, "running"), lt(runs.leaseUntil, now)),
    );

    // 多 worker 下同一候选可能被抢,重试几次再放弃
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidates = await this.db
        .select({ id: runs.id, sessionId: runs.sessionId })
        .from(runs)
        .where(claimable)
        .orderBy(runs.createdAt)
        .limit(1);

      const candidate = candidates[0];
      if (!candidate) return null;

      // 每次认领生成新的栅栏令牌:上一任 worker 手里的旧令牌就此作废
      const fence = randomUUID();
      const res = await this.db
        .update(runs)
        .set({
          status: "running",
          leaseUntil: now + leaseMs,
          leaseOwner: fence,
          startedAt: sql`COALESCE(${runs.startedAt}, NOW())`,
          attempts: sql`${runs.attempts} + 1`,
        })
        // 关键:再次带上可认领条件,把"检查"与"占位"合并成一次原子写
        .where(and(eq(runs.id, candidate.id), claimable));

      if (affectedRows(res) > 0) {
        return {
          id: candidate.id,
          sessionId: candidate.sessionId,
          state: "running",
          leaseUntil: now + leaseMs,
          fence,
        };
      }
      // 被别人抢走了,换下一个候选
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
      .set({ status: state, leaseUntil: null, leaseOwner: null, endedAt: sql`NOW()` })
      .where(and(eq(runs.id, id), eq(runs.status, "running"), ...fenceOf(fence)));
    return affectedRows(res) > 0;
  }

  /** 把租约过期的 running 打回 pending,让其它 worker 能接手。 */
  async reclaimOrphans(now: number): Promise<number> {
    const res = await this.db
      .update(runs)
      .set({ status: "pending", leaseUntil: null })
      .where(and(eq(runs.status, "running"), lt(runs.leaseUntil, now)));
    return affectedRows(res);
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

  /** 取待执行的 prompt(worker 从队列恢复运行时需要)。 */
  async getPrompt(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ prompt: runs.prompt })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return rows[0]?.prompt ?? null;
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

  /** 记录这一轮跑完产生的 SDK 会话,供后续轮次与分支续接。 */
  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    await this.db.update(runs).set({ sdkSessionId }).where(eq(runs.id, id));
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
      createdAt: r.createdAt.getTime(),
    }));
  }

  /** 记录终态结果,供轮询接口读取。 */
  async saveResult(
    id: string,
    data: { structured?: unknown; cost?: unknown; error?: unknown },
    fence?: string,
  ): Promise<void> {
    // 【只写传进来的字段】。曾经是无条件 `?? null` 三连,于是异常路径调用
    // saveResult({error}) 会把上一步刚落库的 structured 与 cost 一起抹成 null ——
    // 一次真正成功、结果已在库里的运行,数据被销毁而不只是被误标。
    const patch: Record<string, unknown> = {};
    if ("structured" in data) patch.structuredResult = data.structured ?? null;
    if ("cost" in data) patch.cost = data.cost ?? null;
    if ("error" in data) patch.errorInfo = data.error ?? null;
    if (Object.keys(patch).length === 0) return;

    await this.db
      .update(runs)
      .set(patch)
      .where(and(eq(runs.id, id), ...fenceOf(fence)));
  }

  /** 取完整运行状态与结果,供对外轮询接口使用。 */
  async getResult(id: string): Promise<{
    id: string;
    status: RunState;
    structured: unknown;
    cost: unknown;
    error: unknown;
    summary: string | null;
  } | null> {
    const rows = await this.db
      .select({
        id: runs.id,
        status: runs.status,
        structured: runs.structuredResult,
        cost: runs.cost,
        error: runs.errorInfo,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as RunState,
      structured: row.structured,
      cost: row.cost,
      error: row.error,
      summary: null,
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
               COALESCE(MAX(UNIX_TIMESTAMP(COALESCE(r.ended_at, r.created_at)) * 1000), 0)
             ) AS lastActiveAt,
             SUM(CASE WHEN r.status IN ('pending','running') THEN 1 ELSE 0 END) AS openRuns
      FROM sessions s
      LEFT JOIN runs r ON r.session_id = s.id
      GROUP BY s.id, s.created_at
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
