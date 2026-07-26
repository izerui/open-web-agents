// MySQL 当队列的 RunRepo 实现:乐观锁认领 + 租约续期 + 孤儿回收,零中间件。
//
// 认领的正确性关键:UPDATE 必须把"筛选条件"和"占位"放在同一条语句里,
// 靠 MySQL 的行锁保证原子性 —— 先 SELECT 再 UPDATE 会在并发下把同一个 run 发给两个 worker。

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

  async create(r: NewRun & { prompt?: string }): Promise<Run> {
    await this.db.insert(runs).values({
      id: r.id,
      sessionId: r.sessionId,
      status: "pending",
      prompt: r.prompt ?? "",
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

      const res = await this.db
        .update(runs)
        .set({
          status: "running",
          leaseUntil: now + leaseMs,
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
        };
      }
      // 被别人抢走了,换下一个候选
    }
    return null;
  }

  async touch(id: string, leaseUntil: number): Promise<void> {
    await this.db
      .update(runs)
      .set({ leaseUntil })
      .where(and(eq(runs.id, id), eq(runs.status, "running")));
  }

  async complete(id: string, state: RunState): Promise<void> {
    await this.db
      .update(runs)
      .set({ status: state, leaseUntil: null, endedAt: sql`NOW()` })
      .where(eq(runs.id, id));
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

  /** 记录终态结果,供轮询接口读取。 */
  async saveResult(
    id: string,
    data: { structured?: unknown; cost?: unknown; error?: unknown },
  ): Promise<void> {
    await this.db
      .update(runs)
      .set({
        structuredResult: data.structured ?? null,
        cost: data.cost ?? null,
        errorInfo: data.error ?? null,
      })
      .where(eq(runs.id, id));
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

  /** 仅测试用:清空队列。 */
  async _truncate(): Promise<void> {
    await this.db.delete(runs).where(sql`1=1`);
  }
}
