import type { Db } from "@/lib/db/client";
import { capabilityCatalog, capabilityVersions } from "@/lib/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { type Capability, type CapabilityDefinition, validateCapability } from "../domain/catalog";
import {
  CapabilityConflict,
  type CapabilityRepo,
  type CapabilityVersion,
  DuplicateModelId,
} from "../ports";

function asCapability(row: { definition: unknown; version: number; updatedAt: Date }): Capability {
  return {
    ...(row.definition as CapabilityDefinition),
    version: row.version,
    updatedAt: row.updatedAt.getTime(),
  };
}

export class MysqlCapabilityRepo implements CapabilityRepo {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Capability | null> {
    const rows = await this.db
      .select()
      .from(capabilityCatalog)
      .where(eq(capabilityCatalog.id, id))
      .limit(1);
    return rows[0] ? asCapability(rows[0]) : null;
  }

  async list(includeDisabled = false): Promise<Capability[]> {
    const rows = await this.db
      .select()
      .from(capabilityCatalog)
      .where(includeDisabled ? undefined : eq(capabilityCatalog.enabled, 1))
      .orderBy(capabilityCatalog.id);
    return rows.map(asCapability);
  }

  async save(
    raw: CapabilityDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<Capability> {
    const definition = validateCapability(raw);
    try {
      return await this.db.transaction(
        async (tx) => {
          // 同一提供者下的保存串行化,文本模型标识的查重才可靠
          if (definition.providerId) {
            await tx.execute(
              sql`SELECT id FROM model_providers WHERE id = ${definition.providerId} FOR UPDATE`,
            );
          }
          await tx.execute(
            sql`SELECT id FROM capability_catalog WHERE id = ${definition.id} FOR UPDATE`,
          );
          if (definition.providerId && definition.kind === "llm") {
            const dup = await tx
              .select({ id: capabilityCatalog.id })
              .from(capabilityCatalog)
              .where(
                and(
                  eq(capabilityCatalog.providerId, definition.providerId),
                  eq(capabilityCatalog.kind, "llm"),
                  eq(capabilityCatalog.modelId, definition.modelId),
                  ne(capabilityCatalog.id, definition.id),
                ),
              )
              .limit(1);
            if (dup[0]) throw new DuplicateModelId(definition.modelId);
          }
          const rows = await tx
            .select()
            .from(capabilityCatalog)
            .where(eq(capabilityCatalog.id, definition.id))
            .limit(1);
          const current = rows[0];
          if ((current?.version ?? null) !== expectedVersion) throw new CapabilityConflict();
          const version = (current?.version ?? 0) + 1;
          const at = new Date();
          const values = {
            id: definition.id,
            kind: definition.kind,
            modelId: definition.modelId,
            providerId: definition.providerId ?? null,
            enabled: definition.enabled ? 1 : 0,
            version,
            definition,
            updatedAt: at,
          };
          if (current)
            await tx
              .update(capabilityCatalog)
              .set(values)
              .where(eq(capabilityCatalog.id, definition.id));
          else await tx.insert(capabilityCatalog).values(values);
          await tx.insert(capabilityVersions).values({
            capabilityId: definition.id,
            version,
            definition,
            createdBy: actorId,
            createdAt: at,
          });
          return { ...definition, version, updatedAt: at.getTime() };
        },
        { isolationLevel: "read committed" },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ER_DUP_ENTRY") throw new CapabilityConflict();
      throw err;
    }
  }

  async retire(id: string, replacedBy: string, actorId: string): Promise<void> {
    await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT id FROM capability_catalog WHERE id = ${id} FOR UPDATE`);
        const rows = await tx
          .select()
          .from(capabilityCatalog)
          .where(eq(capabilityCatalog.id, id))
          .limit(1);
        const row = rows[0];
        if (!row) return;
        const current = row.definition as CapabilityDefinition;
        if (current.replacedBy) return;
        const definition = { ...current, enabled: false, replacedBy };
        const version = row.version + 1;
        const at = new Date();
        await tx
          .update(capabilityCatalog)
          .set({ enabled: 0, version, definition, updatedAt: at })
          .where(eq(capabilityCatalog.id, id));
        await tx.insert(capabilityVersions).values({
          capabilityId: id,
          version,
          definition,
          createdBy: actorId,
          createdAt: at,
        });
      },
      { isolationLevel: "read committed" },
    );
  }

  async version(id: string, version: number): Promise<CapabilityVersion | null> {
    const rows = await this.db
      .select()
      .from(capabilityVersions)
      .where(and(eq(capabilityVersions.capabilityId, id), eq(capabilityVersions.version, version)))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          ...(row.definition as CapabilityDefinition),
          version: row.version,
          updatedAt: row.createdAt.getTime(),
          createdBy: row.createdBy,
        }
      : null;
  }
}
