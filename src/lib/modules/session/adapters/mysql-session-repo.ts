import type { Db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import type { NewSession, Session, SessionRepo } from "@/lib/modules/session/ports";
import type { ModelAlias } from "@/lib/shared";
import { desc, eq } from "drizzle-orm";

interface Row {
  id: string;
  assistantId: string;
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
    assistantId: r.assistantId,
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
  assistantId: sessions.assistantId,
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
  constructor(private readonly db: Db) {}

  async create(s: NewSession): Promise<Session> {
    await this.db.insert(sessions).values({
      id: s.id,
      assistantId: s.assistantId,
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

  async list(): Promise<Session[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      .limit(100);
    return rows.map(toSession);
  }

  async setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    await this.db.update(sessions).set({ sdkSessionId }).where(eq(sessions.id, id));
  }
}
