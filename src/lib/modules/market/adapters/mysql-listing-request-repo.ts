import type { Db } from "@/lib/db/client";
import { marketListingRequests as t } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type {
  ListingDecision,
  ListingRequest,
  ListingRequestRepo,
  ListingRequestStatus,
  NewListingRequest,
} from "../listing-request-ports";

type Row = typeof t.$inferSelect;

function toRequest(r: Row): ListingRequest {
  return {
    id: r.id,
    agentId: r.agentId,
    version: r.version,
    requesterId: r.requesterId,
    ...(r.note ? { note: r.note } : {}),
    status: r.status as ListingRequestStatus,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.category ? { category: r.category } : {}),
    createdAt: r.createdAt,
    ...(r.decidedAt !== null ? { decidedAt: r.decidedAt } : {}),
    ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
  };
}

export class MysqlListingRequestRepo implements ListingRequestRepo {
  constructor(private readonly db: Db) {}

  async create(r: NewListingRequest): Promise<ListingRequest | null> {
    try {
      await this.db.insert(t).values({
        id: r.id,
        agentId: r.agentId,
        version: r.version,
        requesterId: r.requesterId,
        note: r.note ?? null,
        status: "pending",
        pendingAgentId: r.agentId,
        createdAt: r.createdAt,
      });
    } catch (err) {
      // uniq_listing_requests_pending:同一智能体已有待审申请
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") return null;
      throw err;
    }
    return this.get(r.id);
  }

  async get(id: string): Promise<ListingRequest | null> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async latestFor(agentId: string): Promise<ListingRequest | null> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.agentId, agentId))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async list(
    query: { status?: ListingRequestStatus; limit?: number } = {},
  ): Promise<ListingRequest[]> {
    const base = this.db.select().from(t);
    const rows = await (query.status ? base.where(eq(t.status, query.status)) : base)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(Math.min(Math.max(query.limit ?? 200, 1), 500));
    return rows.map(toRequest);
  }

  async decide(id: string, d: ListingDecision): Promise<ListingRequest | null> {
    // 条件更新:只有仍是 pending 的那一行会被改,并发处理时只有一个成功
    const res = await this.db
      .update(t)
      .set({
        status: d.status,
        reason: d.reason ?? null,
        category: d.category ?? null,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        pendingAgentId: null,
      })
      .where(and(eq(t.id, id), eq(t.status, "pending")));
    const affected = (res as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
    if (affected === 0) return null;
    return this.get(id);
  }
}
