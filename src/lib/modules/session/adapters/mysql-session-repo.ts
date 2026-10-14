import type { Db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import type { DesignState } from "@/lib/modules/agent/domain/design";
import type {
  NewSession,
  ReclaimResult,
  Session,
  SessionListFilter,
  SessionRepo,
  SessionSource,
  SessionStatus,
} from "@/lib/modules/session/ports";
import type { ModelAlias } from "@/lib/shared";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

interface Row {
  id: string;
  agentId: string;
  ownerId: string | null;
  callerApiKeyId: string | null;
  billingUserId: string | null;
  workspaceDir: string;
  sdkSessionId: string | null;
  title: string | null;
  unattended: number;
  source: string;
  status: string;
  designTargetAgentId: string | null;
  designState: unknown;
  agentVersion: number | null;
  workspacePurgedAt: number | null;
  workspaceTouchedAt: number | null;
  createdAt: Date;
}

function toSession(r: Row): Session {
  return {
    id: r.id,
    agentId: r.agentId,
    ownerId: r.ownerId ?? undefined,
    callerApiKeyId: r.callerApiKeyId ?? undefined,
    billingUserId: r.billingUserId ?? undefined,
    workspaceDir: r.workspaceDir,
    sdkSessionId: r.sdkSessionId ?? undefined,
    title: r.title ?? undefined,
    unattended: r.unattended === 1,
    source: r.source as SessionSource,
    status: r.status as SessionStatus,
    designTargetAgentId: r.designTargetAgentId ?? undefined,
    designState: (r.designState as DesignState | null) ?? undefined,
    agentVersion: r.agentVersion ?? undefined,
    workspacePurgedAt: r.workspacePurgedAt ?? undefined,
    workspaceTouchedAt: r.workspaceTouchedAt ?? undefined,
    createdAt: r.createdAt.getTime(),
  };
}

const COLUMNS = {
  id: sessions.id,
  agentId: sessions.agentId,
  ownerId: sessions.ownerId,
  callerApiKeyId: sessions.callerApiKeyId,
  billingUserId: sessions.billingUserId,
  workspaceDir: sessions.workspaceDir,
  sdkSessionId: sessions.sdkSessionId,
  title: sessions.title,
  unattended: sessions.unattended,
  source: sessions.source,
  status: sessions.status,
  designTargetAgentId: sessions.designTargetAgentId,
  designState: sessions.designState,
  agentVersion: sessions.agentVersion,
  workspacePurgedAt: sessions.workspacePurgedAt,
  workspaceTouchedAt: sessions.workspaceTouchedAt,
  createdAt: sessions.createdAt,
};

export class MysqlSessionRepo implements SessionRepo {
  /**
   * 仅测试用:清空会话表。
   *
   * 【危险操作,必须显式确认】曾经把 OWA_TEST_DATABASE_URL 指到开发库上跑契约测试,
   * 直接把开发数据删了。故要求调用方传库名自证是测试库 ——
   * 让「误删开发数据」从注意事项变成做不到。参见 MysqlRunRepo._truncate。
   */
  async _truncate(confirmTestDatabase: string): Promise<void> {
    if (!/test/i.test(confirmTestDatabase)) {
      throw new Error(
        `拒绝清空非测试库:${confirmTestDatabase} —— 库名须含 "test"(把 OWA_TEST_DATABASE_URL 指向专用测试库)`,
      );
    }
    await this.db.delete(sessions).where(sql`1=1`);
  }

  constructor(private readonly db: Db) {}

  async create(s: NewSession): Promise<Session> {
    await this.db.insert(sessions).values({
      id: s.id,
      agentId: s.agentId,
      ownerId: s.ownerId,
      callerApiKeyId: s.callerApiKeyId,
      billingUserId: s.billingUserId ?? s.ownerId,
      workspaceDir: s.workspaceDir,
      title: s.title,
      unattended: s.unattended ? 1 : 0,
      source: s.source ?? (s.unattended ? "invoke" : "web"),
      designTargetAgentId: s.designTargetAgentId,
      designState: s.designState,
      agentVersion: s.agentVersion ?? null,
      status: "active",
    });
    const created = await this.get(s.id);
    if (!created) throw new Error(`session insert failed: ${s.id}`);
    return created;
  }

  async get(id: string): Promise<Session | null> {
    const rows = await this.db.select(COLUMNS).from(sessions).where(eq(sessions.id, id)).limit(1);
    const row = rows[0];
    return row ? toSession(row) : null;
  }

  async list(filter?: SessionListFilter): Promise<Session[]> {
    // 过滤下推到 SQL —— 100 条上限的含义才是「这个人最近的 100 条」,
    // 而不是「全库最近 100 条里恰好属于这个人的那几条」
    const conds = [
      filter?.ownerId !== undefined ? eq(sessions.ownerId, filter.ownerId) : undefined,
      filter?.callerApiKeyId !== undefined
        ? eq(sessions.callerApiKeyId, filter.callerApiKeyId)
        : undefined,
      filter?.billingUserId !== undefined
        ? eq(sessions.billingUserId, filter.billingUserId)
        : undefined,
      filter?.sources ? inArray(sessions.source, filter.sources) : undefined,
      filter?.includeArchived ? ne(sessions.status, "deleted") : eq(sessions.status, "active"),
    ].filter((c) => c !== undefined);

    const q = this.db.select(COLUMNS).from(sessions);
    const rows = await (conds.length > 0 ? q.where(and(...conds)) : q)
      .orderBy(desc(sessions.createdAt))
      .limit(100);
    return rows.map(toSession);
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    await this.db.update(sessions).set({ sdkSessionId }).where(eq(sessions.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  async prepareWorkspace(
    id: string,
    opts: { nowMs: number },
    ensure: () => Promise<void>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // 与 GC 的 reclaimWorkspace 抢同一把行锁:GC 正在改名挪走时,这里等它挪完
      await tx.execute(sql`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`);
      await tx.update(sessions).set({ workspaceTouchedAt: opts.nowMs }).where(eq(sessions.id, id));
      await ensure();
    });
  }

  async withWorkspaceLock<T>(
    id: string,
    fn: (state: { workspacePurgedAt?: number } | null) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(
        sql`SELECT workspace_purged_at AS purgedAt FROM sessions WHERE id = ${id} FOR UPDATE`,
      );
      const row = ((locked as unknown as [Record<string, unknown>[]])[0] ?? [])[0];
      if (!row) return fn(null);
      return fn({ workspacePurgedAt: row.purgedAt === null ? undefined : Number(row.purgedAt) });
    });
  }

  async reclaimWorkspace(
    id: string,
    opts: { quietSinceMs: number; nowMs: number; kind: "purge" | "clean" },
    op: () => Promise<boolean>,
  ): Promise<ReclaimResult> {
    return this.db.transaction(async (tx) => {
      // 时间一律按 UNIX_TIMESTAMP 换成毫秒比较,与 listSessionActivity 的口径一致
      const locked = await tx.execute(sql`
        SELECT UNIX_TIMESTAMP(created_at) * 1000 AS createdMs, workspace_touched_at AS touchedMs
        FROM sessions WHERE id = ${id} FOR UPDATE
      `);
      const row = ((locked as unknown as [Record<string, unknown>[]])[0] ?? [])[0];
      if (!row) return "gone";
      if (Number(row.createdMs) >= opts.quietSinceMs) return "busy";
      if (row.touchedMs !== null && Number(row.touchedMs) >= opts.quietSinceMs) return "busy";

      const busy = await tx.execute(sql`
        SELECT 1 AS hit FROM runs r
        WHERE r.session_id = ${id}
          AND (
            UNIX_TIMESTAMP(COALESCE(r.ended_at, r.created_at)) * 1000 >= ${opts.quietSinceMs}
            OR (r.status = 'running' AND r.lease_until > ${opts.nowMs})
            OR (${opts.kind} = 'clean' AND r.status IN ('pending', 'running'))
          )
        LIMIT 1
      `);
      if (((busy as unknown as [unknown[]])[0] ?? []).length > 0) return "busy";

      // 在锁内完成改名:写方此刻在等这把锁,改名之后它才会建新的空目录
      const moved = await op();
      // 什么都没挪(通常是另一个 GC 已挪走):不记标记 —— 否则会把那一批的清理时刻覆盖成本批的
      if (!moved) return "gone";
      if (opts.kind === "purge") {
        // 挪走之后才记,同一事务:提交失败则标记回滚,文件由 GC 核对回收站批次补偿
        await tx.update(sessions).set({ workspacePurgedAt: opts.nowMs }).where(eq(sessions.id, id));
      }
      return "reclaimed";
    });
  }

  async update(
    id: string,
    patch: {
      title?: string;
      status?: SessionStatus;
      designTargetAgentId?: string;
      designState?: DesignState;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.designState !== undefined) set.designState = patch.designState;
    if (patch.designTargetAgentId !== undefined)
      set.designTargetAgentId = patch.designTargetAgentId;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) return;
    await this.db.update(sessions).set(set).where(eq(sessions.id, id));
  }
}
