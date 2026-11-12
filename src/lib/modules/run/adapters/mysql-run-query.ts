// 运行记录的查询侧(读模型):按归属、智能体、状态、来源、时间过滤,游标分页。
//
// 与队列仓储(mysql-run-repo.ts)分开:队列刻意不依赖 sessions 表,
// 而列表要连 sessions 拿归属与来源、连 agents 拿名称。

import type { Db } from "@/lib/db/client";
import { agents, runs, sessions } from "@/lib/db/schema";
import type { SessionSource } from "@/lib/modules/session/ports";
import type { RunState } from "@/lib/shared";
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { type PublicRunCost, publicCost } from "../domain/run-result";

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
  /** 执行的智能体版本;undefined = 草稿 */
  agentVersion?: number;
  source: SessionSource;
  status: RunState;
  promptPreview: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  cost?: PublicRunCost;
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
  agentVersion: runs.agentVersion,
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
  agentVersion: number | null;
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
    agentVersion: r.agentVersion ?? undefined,
    source: r.source as SessionSource,
    status: r.status as RunState,
    promptPreview: r.prompt.slice(0, PREVIEW_CHARS),
    createdAt: r.createdAt.getTime(),
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? endedAt - startedAt : undefined,
    cost: publicCost(r.cost) ?? undefined,
    error: (r.error ?? undefined) as RunListItem["error"],
    parentRunId: r.parentRunId ?? undefined,
  };
}

/** 每个会话最近一次运行的摘要(探索首页「你的 AI 同事正在工作」用)。 */
export interface LatestRun {
  sessionId: string;
  /** 运行 id(取运行中的事件流用);旧调用方可能不给 */
  runId?: string;
  status: RunState;
  /** 本轮输入的前 300 字 */
  promptPreview: string;
  /** 本轮最终回答的前 400 字;还没回答为 undefined */
  replyPreview?: string;
  createdAt: number;
  startedAt?: number;
}

export class MysqlRunQuery {
  constructor(private readonly db: Db) {}

  /**
   * 一批会话各自最近一次运行。窗口函数一条查询取齐,不按会话逐个查。
   * 未出现在结果里的会话 = 还没跑过。
   */
  async latestBySessions(sessionIds: string[]): Promise<Map<string, LatestRun>> {
    const out = new Map<string, LatestRun>();
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return out;
    const res = await this.db.execute(sql`
      SELECT id, session_id, status, prompt_preview, reply_preview, created_ms, started_ms FROM (
        SELECT r.id, r.session_id, r.status,
               LEFT(r.prompt, 300) AS prompt_preview,
               LEFT(r.final_text, 400) AS reply_preview,
               UNIX_TIMESTAMP(r.created_at) * 1000 AS created_ms,
               UNIX_TIMESTAMP(r.started_at) * 1000 AS started_ms,
               ROW_NUMBER() OVER (PARTITION BY r.session_id ORDER BY r.created_at DESC, r.id DESC) AS rn
        FROM runs r
        WHERE r.session_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      ) t WHERE rn = 1`);
    const rows = ((res as unknown as [unknown[]])[0] ?? []) as {
      id: string;
      session_id: string;
      status: string;
      prompt_preview: string | null;
      reply_preview: string | null;
      created_ms: string | number;
      started_ms: string | number | null;
    }[];
    for (const r of rows) {
      const started = r.started_ms === null ? undefined : Number(r.started_ms);
      out.set(r.session_id, {
        sessionId: r.session_id,
        runId: r.id,
        status: r.status as RunState,
        promptPreview: r.prompt_preview ?? "",
        replyPreview: r.reply_preview ?? undefined,
        createdAt: Number(r.created_ms),
        startedAt: Number.isFinite(started) ? started : undefined,
      });
    }
    return out;
  }

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
