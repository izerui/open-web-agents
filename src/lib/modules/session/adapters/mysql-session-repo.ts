import type { Db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import type { NewSession, Session, SessionRepo } from "@/lib/modules/session/ports";
import type { ModelAlias } from "@/lib/shared";
import { and, desc, eq, sql } from "drizzle-orm";

interface Row {
  id: string;
  agentId: string;
  ownerId: string | null;
  callerApiKeyId: string | null;
  workspaceDir: string;
  sdkSessionId: string | null;
  title: string | null;
  baseUrl: string | null;
  model: string | null;
  createdAt: Date;
}

function toSession(r: Row): Session {
  return {
    id: r.id,
    agentId: r.agentId,
    ownerId: r.ownerId ?? undefined,
    callerApiKeyId: r.callerApiKeyId ?? undefined,
    workspaceDir: r.workspaceDir,
    sdkSessionId: r.sdkSessionId ?? undefined,
    title: r.title ?? undefined,
    baseUrl: r.baseUrl ?? undefined,
    model: (r.model as ModelAlias | null) ?? undefined,
    createdAt: r.createdAt.getTime(),
  };
}

const COLUMNS = {
  id: sessions.id,
  agentId: sessions.agentId,
  ownerId: sessions.ownerId,
  callerApiKeyId: sessions.callerApiKeyId,
  workspaceDir: sessions.workspaceDir,
  sdkSessionId: sessions.sdkSessionId,
  title: sessions.title,
  baseUrl: sessions.baseUrl,
  model: sessions.model,
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
      workspaceDir: s.workspaceDir,
      title: s.title,
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

  async list(filter?: { ownerId?: string; callerApiKeyId?: string }): Promise<Session[]> {
    // 过滤下推到 SQL —— 100 条上限的含义才是「这个人最近的 100 条」,
    // 而不是「全库最近 100 条里恰好属于这个人的那几条」
    const conds = [
      filter?.ownerId !== undefined ? eq(sessions.ownerId, filter.ownerId) : undefined,
      filter?.callerApiKeyId !== undefined
        ? eq(sessions.callerApiKeyId, filter.callerApiKeyId)
        : undefined,
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
}
