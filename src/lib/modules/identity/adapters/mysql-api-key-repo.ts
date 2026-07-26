import type { Db } from "@/lib/db/client";
import { apiKeys } from "@/lib/db/schema";
import type { ApiKeyRecord, ApiKeyRepo, NewApiKey } from "@/lib/modules/identity/ports";
import { desc, eq } from "drizzle-orm";

interface Row {
  id: string;
  ownerId: string;
  assistantId: string | null;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const COLUMNS = {
  id: apiKeys.id,
  ownerId: apiKeys.ownerId,
  assistantId: apiKeys.assistantId,
  name: apiKeys.name,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
};

function toRecord(r: Row): ApiKeyRecord {
  return {
    id: r.id,
    ownerId: r.ownerId,
    assistantId: r.assistantId ?? undefined,
    name: r.name ?? undefined,
    createdAt: r.createdAt.getTime(),
    lastUsedAt: r.lastUsedAt?.getTime(),
  };
}

export class MysqlApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly db: Db) {}

  async create(k: NewApiKey): Promise<ApiKeyRecord> {
    await this.db.insert(apiKeys).values({
      id: k.id,
      ownerId: k.ownerId,
      assistantId: k.assistantId,
      name: k.name,
      hashedKey: k.hashedKey,
    });
    const rows = await this.db.select(COLUMNS).from(apiKeys).where(eq(apiKeys.id, k.id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error(`api key insert failed: ${k.id}`);
    return toRecord(row);
  }

  async findByHash(hashedKey: string): Promise<ApiKeyRecord | null> {
    const rows = await this.db
      .select(COLUMNS)
      .from(apiKeys)
      .where(eq(apiKeys.hashedKey, hashedKey))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async list(ownerId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(apiKeys)
      .where(eq(apiKeys.ownerId, ownerId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(200);
    return rows.map(toRecord);
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async touch(id: string, at: number): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(at) })
      .where(eq(apiKeys.id, id));
  }
}
