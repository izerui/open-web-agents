/** 市场上架申请(A13)的形状与仓储端口。可供客户端 type-only 引用。 */

export type ListingRequestStatus = "pending" | "approved" | "rejected";

export const LISTING_REQUEST_STATUSES: readonly ListingRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
];

export interface ListingRequest {
  id: string;
  agentId: string;
  /** 申请时的发布版本号 */
  version: number;
  requesterId: string;
  note?: string;
  status: ListingRequestStatus;
  /** 驳回理由 */
  reason?: string;
  /** 通过时上架到的类别 */
  category?: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface NewListingRequest {
  id: string;
  agentId: string;
  version: number;
  requesterId: string;
  note?: string;
  createdAt: number;
}

export interface ListingDecision {
  status: "approved" | "rejected";
  reason?: string;
  category?: string;
  decidedBy: string;
  decidedAt: number;
}

export interface ListingRequestRepo {
  /** 建一条 pending 申请;同一智能体已有 pending 时返回 null(库里唯一约束兜底并发) */
  create(r: NewListingRequest): Promise<ListingRequest | null>;
  get(id: string): Promise<ListingRequest | null>;
  /** 某智能体最新的一条申请(不论状态) */
  latestFor(agentId: string): Promise<ListingRequest | null>;
  /** 按状态列出,新的在前 */
  list(query?: { status?: ListingRequestStatus; limit?: number }): Promise<ListingRequest[]>;
  /** 处理一条申请;只有 pending 的才会被改,否则返回 null(并发处理时只有一个成功) */
  decide(id: string, d: ListingDecision): Promise<ListingRequest | null>;
}
