// 运行记录的查询侧(读模型):按归属、智能体、状态、来源、时间过滤,游标分页。
//
// 与队列仓储(mysql-run-repo.ts)分开:队列刻意不依赖 sessions 表,
// 而列表要连 sessions 拿归属与来源、连 agents 拿名称。

import type { Db } from "@/lib/db/client";
import { agents, runs, sessions } from "@/lib/db/schema";
import type { SessionSource } from "@/lib/modules/session/ports";
import type { RunState } from "@/lib/shared";
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";

export interface RunQueryFilter {
  /** 计费账号(网页用户看自己名下的全部运行)。 */
  billingUserId?: string;
  /** API Key 只看自己发起的。 */
  callerApiKeyId?: string;
  agentId?: string;
  statuses?: RunState[];
  sources?: SessionSource[];
  since?: number;
  until?: number;
  /** 上一页最后一条的游标(见 encodeCursor)。 */
  cursor?: string;
  limit: number;
}

export interface RunListItem {
  id: string;
  sessionId: string;
  agentId: string;
  agentName?: string;
  source: SessionSource;
  status: RunState;
  promptPreview: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  cost?: { usd?: number; input?: number; output?: number; partial?: boolean };
  error?: { kind?: string; message?: string };
  parentRunId?: string;
}

export interface RunDetail extends RunListItem {
  prompt: string;
  finalText?: string;
  structured?: unknown;
  /** 访问控制用:运行所属会话的归属。 */
  ownership: { ownerId?: string; callerApiKeyId?: string; billingUserId?: string };
}

const PREVIEW_CHARS = 200;

export function encodeCursor(item: { createdAt: number; id: string }): string {
  return Buffer.from(`${item.createdAt}:${item.id}`, "utf8").toString("base64url");
}

function decodeCursor(c: string): { createdAt: number; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, "base64url").toString("utf8").split(":");
    const createdAt = Number(ts);
    if (!id || !Number.isFinite(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

const COLUMNS = {
  id: runs.id,
  sessionId: runs.sessionId,
  agentId: sessions.agentId,
  agentName: agents.name,
  source: sessions.source,
  status: runs.status,
  prompt: runs.prompt,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  cost: runs.cost,
  error: runs.errorInfo,
  parentRunId: runs.parentRunId,
};

type Row = {
  id: string;
  sessionId: string;
  agentId: string;
  agentName: string | null;
  source: string;
  status: string;
  prompt: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  cost: unknown;
  error: unknown;
  parentRunId: string | null;
};

function toItem(r: Row): RunListItem {
  const startedAt = r.startedAt?.getTime();
  const endedAt = r.endedAt?.getTime();
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentId: r.agentId,
    agentName: r.agentName ?? undefined,
    source: r.source as SessionSource,
    status: r.status as RunState,
    promptPreview: r.prompt.slice(0, PREVIEW_CHARS),
    createdAt: r.createdAt.getTime(),
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? endedAt - startedAt : undefined,
    cost: (r.cost ?? undefined) as RunListItem["cost"],
    error: (r.error ?? undefined) as RunListItem["error"],
    parentRunId: r.parentRunId ?? undefined,
  };
}

export class MysqlRunQuery {
  constructor(private readonly db: Db) {}

  async list(f: RunQueryFilter): Promise<{ items: RunListItem[]; nextCursor?: string }> {
    const conds = [
      f.billingUserId !== undefined ? eq(sessions.billingUserId, f.billingUserId) : undefined,
      f.callerApiKeyId !== undefined ? eq(sessions.callerApiKeyId, f.callerApiKeyId) : undefined,
      f.agentId !== undefined ? eq(sessions.agentId, f.agentId) : undefined,
      f.statuses?.length ? inArray(runs.status, f.statuses) : undefined,
      f.sources?.length ? inArray(sessions.source, f.sources) : undefined,
      f.since !== undefined ? gte(runs.createdAt, new Date(f.since)) : undefined,
      f.until !== undefined ? lte(runs.createdAt, new Date(f.until)) : undefined,
    ];
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    if (cursor) {
      const at = new Date(cursor.createdAt);
      conds.push(or(lt(runs.createdAt, at), and(eq(runs.createdAt, at), lt(runs.id, cursor.id))));
    }
    const where = conds.filter((c) => c !== undefined);
    const rows = (await this.db
      .select(COLUMNS)
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .where(where.length ? and(...where) : sql`1=1`)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(f.limit + 1)) as Row[];

    const items = rows.slice(0, f.limit).map(toItem);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > f.limit && last ? encodeCursor(last) : undefined,
    };
  }

  async detail(id: string): Promise<RunDetail | null> {
    const rows = (await this.db
      .select({
        ...COLUMNS,
        finalText: runs.finalText,
        structured: runs.structuredResult,
        ownerId: sessions.ownerId,
        callerApiKeyId: sessions.callerApiKeyId,
        billingUserId: sessions.billingUserId,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .where(eq(runs.id, id))
      .limit(1)) as (Row & {
      finalText: string | null;
      structured: unknown;
      ownerId: string | null;
      callerApiKeyId: string | null;
      billingUserId: string | null;
    })[];
    const r = rows[0];
    if (!r) return null;
    return {
      ...toItem(r),
      prompt: r.prompt,
      finalText: r.finalText ?? undefined,
      structured: r.structured ?? undefined,
      ownership: {
        ownerId: r.ownerId ?? undefined,
        callerApiKeyId: r.callerApiKeyId ?? undefined,
        billingUserId: r.billingUserId ?? undefined,
      },
    };
  }
}
