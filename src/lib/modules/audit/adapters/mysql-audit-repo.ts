import type { Db } from "@/lib/db/client";
import { auditLogs } from "@/lib/db/schema";
import { decodeAuditCursor, encodeAuditCursor } from "@/lib/modules/audit/domain/cursor";
import type { AuditAction } from "@/lib/modules/audit/domain/events";
import type { AuditActorType, AuditEvent, AuditFilter, AuditRepo } from "@/lib/modules/audit/ports";
import { type SQL, and, desc, eq, gte, lt, lte, or } from "drizzle-orm";

export class MysqlAuditRepo implements AuditRepo {
  constructor(private readonly db: Db) {}

  async append(e: AuditEvent): Promise<void> {
    await this.db
      .insert(auditLogs)
      .values({
        id: e.id,
        atMs: e.at,
        actorType: e.actor.type,
        actorId: e.actor.id ?? null,
        actorLabel: e.actor.label?.slice(0, 255) ?? null,
        action: e.action,
        resourceType: e.resource.type,
        resourceId: e.resource.id ?? null,
        ownerId: e.ownerId ?? null,
        details: e.details ?? null,
        ip: e.ip?.slice(0, 64) ?? null,
        userAgent: e.userAgent?.slice(0, 256) ?? null,
      })
      // 同一 id 已存在(去重键重放):保留第一条,不改写
      .onDuplicateKeyUpdate({ set: { id: e.id } });
  }

  async list(f: AuditFilter): Promise<{ items: AuditEvent[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const conds: (SQL | undefined)[] = [
      f.visibleTo !== undefined
        ? or(eq(auditLogs.ownerId, f.visibleTo), eq(auditLogs.actorId, f.visibleTo))
        : undefined,
      f.action !== undefined ? eq(auditLogs.action, f.action) : undefined,
      f.resourceType !== undefined ? eq(auditLogs.resourceType, f.resourceType) : undefined,
      f.resourceId !== undefined ? eq(auditLogs.resourceId, f.resourceId) : undefined,
      f.since !== undefined ? gte(auditLogs.atMs, f.since) : undefined,
      f.until !== undefined ? lte(auditLogs.atMs, f.until) : undefined,
    ];
    const c = f.cursor ? decodeAuditCursor(f.cursor) : null;
    if (c) {
      conds.push(
        or(lt(auditLogs.atMs, c.at), and(eq(auditLogs.atMs, c.at), lt(auditLogs.id, c.id))),
      );
    }
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.atMs), desc(auditLogs.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(
      (r): AuditEvent => ({
        id: r.id,
        at: r.atMs,
        actor: {
          type: r.actorType as AuditActorType,
          id: r.actorId ?? undefined,
          label: r.actorLabel ?? undefined,
        },
        // 库里的字符串原样回显 —— 将来改名或下线的动作,历史记录照样看得到
        action: r.action as AuditAction,
        resource: { type: r.resourceType, id: r.resourceId ?? undefined },
        ownerId: r.ownerId ?? undefined,
        details: (r.details as Record<string, unknown> | null) ?? undefined,
        ip: r.ip ?? undefined,
        userAgent: r.userAgent ?? undefined,
      }),
    );
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last) : undefined,
    };
  }
}
