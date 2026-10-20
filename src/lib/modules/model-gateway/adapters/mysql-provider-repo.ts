import type { Db } from "@/lib/db/client";
import { modelAliases, modelProviders, platformState } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  type ModelAliasMap,
  type ModelAliases,
  type Provider,
  type ProviderDefinition,
  type ProviderEndpoints,
  validateAliasMap,
  validateProvider,
} from "../domain/provider";
import {
  type BootstrapMarker,
  type ModelAliasRepo,
  ProviderConflict,
  type ProviderRepo,
} from "../ports";

type ProviderRow = typeof modelProviders.$inferSelect;

function asProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    endpoints: row.endpoints as ProviderEndpoints,
    hasKey: row.apiKeyEnc !== null,
    keyHint: row.keyHint,
    version: row.version,
    updatedAt: row.updatedAt.getTime(),
  };
}

const ALIAS_ROW = "default";

export class MysqlProviderRepo implements ProviderRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<Provider[]> {
    const rows = await this.db.select().from(modelProviders).orderBy(modelProviders.id);
    return rows.map(asProvider);
  }

  async get(id: string): Promise<Provider | null> {
    const rows = await this.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .limit(1);
    return rows[0] ? asProvider(rows[0]) : null;
  }

  async save(
    raw: ProviderDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<Provider> {
    const def = validateProvider(raw);
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT id FROM model_providers WHERE id = ${def.id} FOR UPDATE`);
          const rows = await tx
            .select()
            .from(modelProviders)
            .where(eq(modelProviders.id, def.id))
            .limit(1);
          const current = rows[0];
          if ((current?.version ?? null) !== expectedVersion) throw new ProviderConflict();
          const at = new Date();
          const values = {
            name: def.name,
            enabled: def.enabled ? 1 : 0,
            endpoints: def.endpoints,
            version: (current?.version ?? 0) + 1,
            updatedBy: actorId,
            updatedAt: at,
          };
          if (current) {
            await tx.update(modelProviders).set(values).where(eq(modelProviders.id, def.id));
          } else {
            await tx.insert(modelProviders).values({ id: def.id, ...values, createdAt: at });
          }
          const saved = await tx
            .select()
            .from(modelProviders)
            .where(eq(modelProviders.id, def.id))
            .limit(1);
          if (!saved[0]) throw new Error("提供者保存后读取失败");
          return asProvider(saved[0]);
        },
        { isolationLevel: "read committed" },
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "ER_DUP_ENTRY") {
        throw new ProviderConflict(
          e.message?.includes("name_unique") ? "名称已被其他提供者使用" : undefined,
        );
      }
      throw err;
    }
  }

  async setKey(id: string, keyEnc: string, keyHint: string, actorId: string): Promise<void> {
    const [res] = await this.db
      .update(modelProviders)
      .set({ apiKeyEnc: keyEnc, keyHint, updatedBy: actorId, updatedAt: new Date() })
      .where(eq(modelProviders.id, id));
    if ((res as { affectedRows?: number }).affectedRows === 0) throw new Error("提供者不存在");
  }

  async keyEnc(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ k: modelProviders.apiKeyEnc })
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .limit(1);
    return rows[0]?.k ?? null;
  }
}

export class MysqlModelAliasRepo implements ModelAliasRepo {
  constructor(private readonly db: Db) {}

  async get(): Promise<ModelAliases | null> {
    const rows = await this.db
      .select()
      .from(modelAliases)
      .where(eq(modelAliases.id, ALIAS_ROW))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          providerId: r.providerId,
          fable: r.fable,
          opus: r.opus,
          sonnet: r.sonnet,
          haiku: r.haiku,
          version: r.version,
          updatedAt: r.updatedAt.getTime(),
        }
      : null;
  }

  async save(
    raw: ModelAliasMap,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<ModelAliases> {
    const map = validateAliasMap(raw);
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT id FROM model_aliases WHERE id = ${ALIAS_ROW} FOR UPDATE`);
          const rows = await tx
            .select({ version: modelAliases.version })
            .from(modelAliases)
            .where(eq(modelAliases.id, ALIAS_ROW))
            .limit(1);
          const currentVersion = rows[0]?.version ?? null;
          if (currentVersion !== expectedVersion) {
            throw new ProviderConflict("别名映射已变化,请刷新后重试");
          }
          const at = new Date();
          const values = {
            ...map,
            version: (currentVersion ?? 0) + 1,
            updatedBy: actorId,
            updatedAt: at,
          };
          if (currentVersion === null) {
            await tx.insert(modelAliases).values({ id: ALIAS_ROW, ...values });
          } else {
            await tx.update(modelAliases).set(values).where(eq(modelAliases.id, ALIAS_ROW));
          }
          return { ...map, version: values.version, updatedAt: at.getTime() };
        },
        { isolationLevel: "read committed" },
      );
    } catch (err) {
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
        throw new ProviderConflict("别名映射已变化,请刷新后重试");
      }
      throw err;
    }
  }
}

export class MysqlBootstrapMarker implements BootstrapMarker {
  constructor(private readonly db: Db) {}

  async isDone(key: string): Promise<boolean> {
    const rows = await this.db
      .select({ k: platformState.k })
      .from(platformState)
      .where(eq(platformState.k, key))
      .limit(1);
    return rows.length > 0;
  }

  async markDone(key: string): Promise<void> {
    try {
      await this.db.insert(platformState).values({ k: key, v: "done" });
    } catch (err) {
      // 另一个进程同时完成了同一份初始化
      if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
    }
  }
}
