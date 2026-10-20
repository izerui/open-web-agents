import { decodeAuditCursor, encodeAuditCursor } from "@/lib/modules/audit/domain/cursor";
import type { AuditEvent, AuditFilter, AuditRepo } from "@/lib/modules/audit/ports";

/** 内存审计仓储:测试用,语义与 MySQL 实现一致(倒序、键集分页、可见性过滤)。 */
export class InMemoryAuditRepo implements AuditRepo {
  readonly events: AuditEvent[] = [];

  async append(e: AuditEvent): Promise<void> {
    if (this.events.some((x) => x.id === e.id)) return;
    this.events.push(structuredClone(e));
  }

  async list(f: AuditFilter): Promise<{ items: AuditEvent[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const c = f.cursor ? decodeAuditCursor(f.cursor) : null;
    const sorted = this.events
      .filter(
        (e) =>
          (f.visibleTo === undefined || e.ownerId === f.visibleTo || e.actor.id === f.visibleTo) &&
          (f.action === undefined || e.action === f.action) &&
          (f.resourceType === undefined || e.resource.type === f.resourceType) &&
          (f.resourceId === undefined || e.resource.id === f.resourceId) &&
          (f.since === undefined || e.at >= f.since) &&
          (f.until === undefined || e.at <= f.until) &&
          (!c || e.at < c.at || (e.at === c.at && e.id < c.id)),
      )
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    const items = sorted.slice(0, limit).map((e) => structuredClone(e));
    const last = items.at(-1);
    return {
      items,
      nextCursor: sorted.length > limit && last ? encodeAuditCursor(last) : undefined,
    };
  }
}
