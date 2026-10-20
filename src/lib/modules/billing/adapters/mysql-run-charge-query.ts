import type { Db } from "@/lib/db/client";
import { agents, runCharges, runs, sessions } from "@/lib/db/schema";
import { and, desc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import { type BillingMode, type HoldRejection, monthWindowUtc } from "../domain/run-charge";
import type { RunChargeItem, RunChargeQuery, TrialStats } from "../run-charge-ports";
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

const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

function encodeCursor(c: { createdAt: number; runId: string }) {
  return `${c.createdAt}_${c.runId}`;
}

function decodeCursor(raw: string): { createdAt: number; runId: string } {
  const m = /^(\d{1,15})_([A-Za-z0-9_-]{1,36})$/.exec(raw);
  if (!m) throw new Error("cursor 无效");
  return { createdAt: Number(m[1]), runId: m[2] as string };
}

export class MysqlRunChargeQuery implements RunChargeQuery {
  constructor(private readonly db: Db) {}

  async listByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string },
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
      ({ c, agentName }): RunChargeItem => ({
        runId: c.runId,
        mode: c.mode as BillingMode,
        state: c.state as RunChargeItem["state"],
        reservedMicro: c.reservedMicro,
        estimatedMicro: c.estimatedMicro,
        chargedMicro: c.chargedMicro,
        owedMicro: c.owedMicro,
        wouldReject: (c.wouldReject as HoldRejection | null) ?? null,
        incomplete: c.incomplete === 1,
        createdAt: c.createdAt.getTime(),
        settledAt: c.settledAt?.getTime() ?? null,
        agentName: agentName ?? null,
        apiKeyId: c.apiKeyId,
      }),
    );
    const last = page.at(-1);
    return {
      items: page,
      ...(rows.length > opts.limit && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async monthUsageByAccount(mode: BillingMode, since: number): Promise<Map<string, bigint>> {
    const rows = await this.db
      .select({ id: runCharges.accountId, used: usedOf(mode) })
      .from(runCharges)
      .where(and(eq(runCharges.mode, mode), inMonth(since)))
      .groupBy(runCharges.accountId);
    return new Map(rows.map((r) => [r.id, big(r.used)]));
  }

  async monthUsageByKey(
    accountId: string,
    mode: BillingMode,
    since: number,
  ): Promise<Map<string, bigint>> {
    const rows = await this.db
      .select({ id: runCharges.apiKeyId, used: usedOf(mode) })
      .from(runCharges)
      .where(
        and(
          eq(runCharges.accountId, accountId),
          eq(runCharges.mode, mode),
          isNotNull(runCharges.apiKeyId),
          inMonth(since),
        ),
      )
      .groupBy(runCharges.apiKeyId);
    return new Map(rows.flatMap((r) => (r.id ? [[r.id, big(r.used)] as const] : [])));
  }

  async trialStats(since: number): Promise<TrialStats> {
    const [row] = await this.db
      .select({
        runs: sql<number>`COUNT(*)`,
        estimated: sql<
          string | null
        >`SUM(CASE WHEN ${runCharges.state} = 'open' THEN 0 ELSE COALESCE(${runCharges.estimatedMicro}, 0) END)`,
        wouldReject: sql<number>`SUM(CASE WHEN ${runCharges.wouldReject} IS NULL THEN 0 ELSE 1 END)`,
      })
      .from(runCharges)
      .where(and(eq(runCharges.mode, "trial"), inMonth(since)));
    return {
      since,
      runs: Number(row?.runs ?? 0),
      estimatedMicro: big(row?.estimated).toString(),
      wouldReject: Number(row?.wouldReject ?? 0),
    };
  }
}
