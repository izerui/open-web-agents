import type {
  ListingDecision,
  ListingRequest,
  ListingRequestRepo,
  ListingRequestStatus,
  NewListingRequest,
} from "../listing-request-ports";

/** 测试与无库场景用;语义与 MySQL 实现一致(见 listing-requests.test.ts 的契约用例) */
export class InMemoryListingRequestRepo implements ListingRequestRepo {
  private readonly rows = new Map<string, ListingRequest>();

  async create(r: NewListingRequest): Promise<ListingRequest | null> {
    for (const row of this.rows.values()) {
      if (row.agentId === r.agentId && row.status === "pending") return null;
    }
    const { note, ...rest } = r;
    const row: ListingRequest = { ...rest, ...(note ? { note } : {}), status: "pending" };
    this.rows.set(r.id, row);
    return { ...row };
  }

  async get(id: string): Promise<ListingRequest | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async latestFor(agentId: string): Promise<ListingRequest | null> {
    return (await this.list()).find((r) => r.agentId === agentId) ?? null;
  }

  async list(
    query: { status?: ListingRequestStatus; limit?: number } = {},
  ): Promise<ListingRequest[]> {
    return [...this.rows.values()]
      .filter((r) => !query.status || r.status === query.status)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, query.limit ?? 200)
      .map((r) => ({ ...r }));
  }

  async decide(id: string, d: ListingDecision): Promise<ListingRequest | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== "pending") return null;
    const next: ListingRequest = {
      ...row,
      status: d.status,
      decidedBy: d.decidedBy,
      decidedAt: d.decidedAt,
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.category ? { category: d.category } : {}),
    };
    this.rows.set(id, next);
    return { ...next };
  }
}
