import type { Db } from "@/lib/db/client";
import { webhookDeliveries } from "@/lib/db/schema";
import { decodeAuditCursor, encodeAuditCursor } from "@/lib/modules/audit/domain/cursor";
import type { WebhookDelivery, WebhookDeliveryLog } from "@/lib/modules/integration/ports";
import { and, desc, eq, lt, or } from "drizzle-orm";

export class MysqlWebhookDeliveryLog implements WebhookDeliveryLog {
  constructor(private readonly db: Db) {}

  async record(d: WebhookDelivery): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: d.id,
      agentId: d.agentId,
      runId: d.runId ?? null,
      trigger: d.trigger,
      attempt: d.attempt ?? null,
      url: d.url.slice(0, 512),
      httpStatus: d.httpStatus ?? null,
      ok: d.ok ? 1 : 0,
      error: d.error?.slice(0, 512) ?? null,
      durationMs: Math.max(0, Math.round(d.durationMs)),
      signed: d.signed ? 1 : 0,
      atMs: d.at,
    });
  }

  async listByAgent(
    agentId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<{ items: WebhookDelivery[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const c = q.cursor ? decodeAuditCursor(q.cursor) : null;
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.agentId, agentId),
          c
            ? or(
                lt(webhookDeliveries.atMs, c.at),
                and(eq(webhookDeliveries.atMs, c.at), lt(webhookDeliveries.id, c.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(webhookDeliveries.atMs), desc(webhookDeliveries.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(
      (r): WebhookDelivery => ({
        id: r.id,
        agentId: r.agentId,
        runId: r.runId ?? undefined,
        trigger: r.trigger as "auto" | "test",
        attempt: r.attempt ?? undefined,
        url: r.url,
        httpStatus: r.httpStatus ?? undefined,
        ok: r.ok === 1,
        error: r.error ?? undefined,
        durationMs: r.durationMs,
        signed: r.signed === 1,
        at: r.atMs,
      }),
    );
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last) : undefined,
    };
  }
}
