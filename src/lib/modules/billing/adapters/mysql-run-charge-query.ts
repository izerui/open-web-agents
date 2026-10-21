import type { Db } from "@/lib/db/client";
import { agents, apiKeys, runCharges, runs, sessions, users } from "@/lib/db/schema";
import type { RunPricing } from "@/lib/shared";
import { type SQL, and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  type ChargeSummaryRow,
  SESSION_SOURCE_TO_CHARGE,
  type SummaryDimension,
} from "../domain/charge-summary";
import { monthWindowUtc } from "../domain/run-charge";
import {
  PENDING_REASONS,
  type PendingChargeItem,
  type PendingReason,
  type ReconRawRow,
  type RunChargeFilter,
  type RunChargeItem,
  type RunChargeQuery,
} from "../run-charge-ports";
import { monthUsedSql } from "./mysql-run-charge-store";

/** 与受理时的额度检查同一个口径(见 monthUsedSql) */
const usedOf = monthUsedSql;

/** 统计窗口:传入月份起点所在的自然月,与受理时检查的窗口一致 */
const inMonth = (since: number) => {
  const w = monthWindowUtc(since);
  return and(
    gte(runCharges.createdAt, new Date(w.since)),
    lt(runCharges.createdAt, new Date(w.until)),
  );
};

/**
 * 会话来源 → 展示来源(api 与 invoke 合并);会话不存在的归 other。
 * 常量直接写进 SQL(取自代码里的固定映射)而不是绑定参数:GROUP BY 与 SELECT 各绑一份参数时,
 * MySQL 认不出两者是同一个表达式(ONLY_FULL_GROUP_BY 下报错)
 */
const SOURCE_SQL: SQL<string> = sql<string>`CASE ${sql.join(
  Object.entries(SESSION_SOURCE_TO_CHARGE).map(([from, to]) => {
    if (!/^[a-z]+$/.test(from) || !/^[a-z]+$/.test(to)) throw new Error("来源映射须为小写字母");
    return sql`WHEN ${sessions.source} = '${sql.raw(from)}' THEN '${sql.raw(to)}'`;
  }),
  sql` `,
)} ELSE 'other' END`;

/** 明细筛选:窗口 + 一个维度的取值(取值口径与 summarize 的归组一致) */
function filterOf(f: RunChargeFilter | undefined): SQL | undefined {
  if (!f) return undefined;
  return and(
    f.since !== undefined ? gte(runCharges.createdAt, new Date(f.since)) : undefined,
    f.until !== undefined ? lt(runCharges.createdAt, new Date(f.until)) : undefined,
    f.source !== undefined ? sql`${SOURCE_SQL} = ${f.source}` : undefined,
    f.agentId === undefined
      ? undefined
      : f.agentId === null
        ? isNull(agents.id)
        : eq(agents.id, f.agentId),
    f.apiKeyId === undefined
      ? undefined
      : f.apiKeyId === null
        ? isNull(runCharges.apiKeyId)
        : eq(runCharges.apiKeyId, f.apiKeyId),
  );
}

const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

function encodeCursor(c: { createdAt: number; runId: string }) {
  return `${c.createdAt}_${c.runId}`;
}

function decodeCursor(raw: string): { createdAt: number; runId: string } {
  const m = /^(\d{1,15})_([A-Za-z0-9_-]{1,36})$/.exec(raw);
  if (!m) throw new Error("cursor 无效");
  return { createdAt: Number(m[1]), runId: m[2] as string };
}

type Row = typeof runCharges.$inferSelect;

function itemOf(c: Row, agentName: string | null): RunChargeItem {
  return {
    runId: c.runId,
    state: c.state as RunChargeItem["state"],
    reservedMicro: c.reservedMicro,
    estimatedMicro: c.estimatedMicro,
    chargedMicro: c.chargedMicro,
    owedMicro: c.owedMicro,
    refundedMicro: c.refundedMicro ?? null,
    incomplete: c.incomplete === 1,
    createdAt: c.createdAt.getTime(),
    settledAt: c.settledAt?.getTime() ?? null,
    agentName: agentName ?? null,
    apiKeyId: c.apiKeyId,
  };
}

/**
 * 暂记的原因(见 PendingReason),与结算写入的字段一一对应:
 * 欠额 > 0 → owed;结算时没有花费(指纹为空)→ usage_unknown;其余 → unpriced
 */
const PENDING_REASON_SQL = sql<string>`CASE
  WHEN COALESCE(${runCharges.owedMicro}, 0) > 0 THEN 'owed'
  WHEN ${runCharges.settledCostDigest} IS NULL THEN 'usage_unknown'
  ELSE 'unpriced' END`;

export class MysqlRunChargeQuery implements RunChargeQuery {
  constructor(private readonly db: Db) {}

  async listByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string; filter?: RunChargeFilter },
  ): Promise<{ items: RunChargeItem[]; nextCursor?: string }> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const at = cursor ? new Date(cursor.createdAt) : null;
    const rows = await this.db
      .select({ c: runCharges, agentName: agents.name })
      .from(runCharges)
      .leftJoin(runs, eq(runs.id, runCharges.runId))
      .leftJoin(sessions, eq(sessions.id, runs.sessionId))
      .leftJoin(agents, eq(agents.id, sessions.agentId))
      .where(
        and(
          eq(runCharges.accountId, accountId),
          filterOf(opts.filter),
          at && cursor
            ? or(
                lt(runCharges.createdAt, at),
                and(eq(runCharges.createdAt, at), lt(runCharges.runId, cursor.runId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(runCharges.createdAt), desc(runCharges.runId))
      .limit(opts.limit + 1);
    const page = rows.slice(0, opts.limit).map(({ c, agentName }) => itemOf(c, agentName));
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > opts.limit && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async listPending(opts: {
    reason?: PendingReason;
    limit: number;
    cursor?: string;
  }): Promise<{ items: PendingChargeItem[]; nextCursor?: string }> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    const at = cursor ? new Date(cursor.createdAt) : null;
    const rows = await this.db
      .select({
        c: runCharges,
        agentName: agents.name,
        email: users.email,
        reason: PENDING_REASON_SQL,
      })
      .from(runCharges)
      .leftJoin(users, eq(users.id, runCharges.accountId))
      .leftJoin(runs, eq(runs.id, runCharges.runId))
      .leftJoin(sessions, eq(sessions.id, runs.sessionId))
      .leftJoin(agents, eq(agents.id, sessions.agentId))
      .where(
        and(
          eq(runCharges.state, "provisional"),
          opts.reason ? sql`${PENDING_REASON_SQL} = ${opts.reason}` : undefined,
          at && cursor
            ? or(
                lt(runCharges.createdAt, at),
                and(eq(runCharges.createdAt, at), lt(runCharges.runId, cursor.runId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(runCharges.createdAt), desc(runCharges.runId))
      .limit(opts.limit + 1);
    const page = rows.slice(0, opts.limit).map(
      ({ c, agentName, email, reason }): PendingChargeItem => ({
        ...itemOf(c, agentName),
        reason: reason as PendingReason,
        accountId: c.accountId,
        accountEmail: email ?? null,
      }),
    );
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > opts.limit && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async reconciliationRows(opts: {
    from: string;
    to: string;
    limit: number;
  }): Promise<{ rows: ReconRawRow[]; truncated: boolean }> {
    // 日期与区间都用运行表自己的创建时间(数据库写的)和字符串边界,在数据库时钟下比较
    const rows = await this.db
      .select({
        day: sql<string>`DATE_FORMAT(${runs.createdAt}, '%Y-%m-%d')`,
        pricing: runs.pricing,
        cost: runs.cost,
        snapshot: runs.usageSnapshot,
        started: sql<number>`(${runs.startedAt} IS NOT NULL)`,
        state: runCharges.state,
        finalWaitSettled: runCharges.finalWaitSettled,
        estimatedMicro: runCharges.estimatedMicro,
        chargedMicro: runCharges.chargedMicro,
      })
      .from(runCharges)
      .innerJoin(runs, eq(runs.id, runCharges.runId))
      .where(
        and(
          sql`${runs.createdAt} >= ${`${opts.from} 00:00:00`}`,
          sql`${runs.createdAt} < DATE_ADD(${`${opts.to} 00:00:00`}, INTERVAL 1 DAY)`,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(opts.limit + 1);
    return {
      truncated: rows.length > opts.limit,
      rows: rows.slice(0, opts.limit).map((r) => {
        const pricing = (r.pricing as RunPricing | null) ?? null;
        // "受理时不可用"的标记没有价目
        const priced = pricing && "providerId" in pricing ? pricing : null;
        return {
          day: r.day,
          providerId: priced?.providerId ?? null,
          pricing: priced,
          state: r.state as ReconRawRow["state"],
          started: Number(r.started) === 1,
          finalWaitSettled: r.finalWaitSettled === 1,
          estimatedMicro: r.estimatedMicro,
          chargedMicro: r.chargedMicro,
          cost: r.cost ?? null,
          snapshot: r.snapshot ?? null,
        };
      }),
    };
  }

  async summarize(opts: {
    accountId?: string;
    since: number;
    until: number;
    by: SummaryDimension;
  }): Promise<ChargeSummaryRow[]> {
    const group: { key: SQL; name: SQL } = {
      source: { key: SOURCE_SQL, name: sql`NULL` },
      agent: { key: sql`${agents.id}`, name: sql`MAX(${agents.name})` },
      key: { key: sql`${runCharges.apiKeyId}`, name: sql`MAX(${apiKeys.name})` },
      account: { key: sql`${runCharges.accountId}`, name: sql`MAX(${users.email})` },
    }[opts.by];
    const open = sql`${runCharges.state} = 'open'`;
    const used = usedOf();
    const rows = await this.db
      .select({
        key: sql<string | null>`${group.key}`,
        name: sql<string | null>`${group.name}`,
        runs: sql<number>`COUNT(*)`,
        charged: sql<
          string | null
        >`SUM(CASE WHEN ${open} THEN 0 ELSE COALESCE(${runCharges.chargedMicro}, 0) END)`,
        owed: sql<
          string | null
        >`SUM(CASE WHEN ${open} THEN 0 ELSE COALESCE(${runCharges.owedMicro}, 0) END)`,
        reserved: sql<
          string | null
        >`SUM(CASE WHEN ${open} THEN ${runCharges.reservedMicro} ELSE 0 END)`,
        used,
      })
      .from(runCharges)
      .leftJoin(runs, eq(runs.id, runCharges.runId))
      .leftJoin(sessions, eq(sessions.id, runs.sessionId))
      .leftJoin(agents, eq(agents.id, sessions.agentId))
      .leftJoin(apiKeys, eq(apiKeys.id, runCharges.apiKeyId))
      .leftJoin(users, eq(users.id, runCharges.accountId))
      .where(
        and(
          opts.accountId ? eq(runCharges.accountId, opts.accountId) : undefined,
          gte(runCharges.createdAt, new Date(opts.since)),
          lt(runCharges.createdAt, new Date(opts.until)),
        ),
      )
      .groupBy(group.key)
      .orderBy(desc(used));
    return rows.map((r) => ({
      key: r.key ?? null,
      name: r.name ?? null,
      runs: Number(r.runs),
      chargedMicro: big(r.charged).toString(),
      owedMicro: big(r.owed).toString(),
      reservedMicro: big(r.reserved).toString(),
      usedMicro: big(r.used).toString(),
    }));
  }

  async pendingCounts(): Promise<Record<PendingReason, number>> {
    const rows = await this.db
      .select({ reason: PENDING_REASON_SQL, n: sql<number>`COUNT(*)` })
      .from(runCharges)
      .where(eq(runCharges.state, "provisional"))
      .groupBy(PENDING_REASON_SQL);
    const out = Object.fromEntries(PENDING_REASONS.map((r) => [r, 0])) as Record<
      PendingReason,
      number
    >;
    for (const r of rows) out[r.reason as PendingReason] = Number(r.n);
    return out;
  }

  async monthUsageByAccount(since: number, accountId?: string): Promise<Map<string, bigint>> {
    const rows = await this.db
      .select({ id: runCharges.accountId, used: usedOf() })
      .from(runCharges)
      .where(and(inMonth(since), accountId ? eq(runCharges.accountId, accountId) : undefined))
      .groupBy(runCharges.accountId);
    return new Map(rows.map((r) => [r.id, big(r.used)]));
  }

  async monthUsageByKey(accountId: string, since: number): Promise<Map<string, bigint>> {
    const rows = await this.db
      .select({ id: runCharges.apiKeyId, used: usedOf() })
      .from(runCharges)
      .where(
        and(eq(runCharges.accountId, accountId), isNotNull(runCharges.apiKeyId), inMonth(since)),
      )
      .groupBy(runCharges.apiKeyId);
    return new Map(rows.flatMap((r) => (r.id ? [[r.id, big(r.used)] as const] : [])));
  }
}
