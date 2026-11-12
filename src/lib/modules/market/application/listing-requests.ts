// 市场上架申请(A13):所有者申请 → 管理员通过(复用 AgentMarket.setListing 上架)或驳回。

import { randomUUID } from "node:crypto";
import type { Subject } from "@/lib/modules/access/domain/grants";
import { type Principal, canAdministerPlatform } from "@/lib/modules/access/domain/principal";
import type { AgentReleases } from "@/lib/modules/agent/application/releases";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";
import type { Agent } from "@/lib/modules/agent/ports";
import { validCategory } from "../domain/catalog";
import {
  LISTING_REQUEST_STATUSES,
  type ListingRequest,
  type ListingRequestRepo,
  type ListingRequestStatus,
} from "../listing-request-ports";
import { type AgentMarket, MarketError } from "./catalog";

/** 申请说明与驳回理由的长度上限(字符) */
export const LISTING_TEXT_MAX = 500;

function text(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new MarketError(400, "invalid_request", `${field}必须是文字`);
  const value = raw.trim();
  if (value.length > LISTING_TEXT_MAX) {
    throw new MarketError(400, "invalid_request", `${field}不能超过 ${LISTING_TEXT_MAX} 字`);
  }
  return value || undefined;
}

function body(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MarketError(400, "invalid_request", "请求体必须是对象");
  }
  return raw as Record<string, unknown>;
}

export class ListingRequests {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly deps: {
      repo: ListingRequestRepo;
      releases: Pick<AgentReleases, "publishedOf">;
      market: Pick<AgentMarket, "setListing">;
      now?: () => number;
      newId?: () => string;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID().replace(/-/g, "").slice(0, 24));
  }

  /**
   * 只有所有者与管理员能申请、能看申请状态,且只限网页登录。
   * 被授 write 的协作者能改草稿,但上架是把智能体对全平台公开使用,属于所有者的决定。
   */
  private assertOwner(principal: Principal, subject: Subject, agent: Agent) {
    const ok =
      principal.type === "web" && (agent.ownerId === subject.userId || subject.role === "admin");
    if (!ok) throw new MarketError(403, "forbidden", "只有智能体所有者可以申请上架");
    if (isSystemAgent(agent.id)) throw new MarketError(404, "not_found", "智能体不存在");
  }

  private assertAdmin(principal: Principal) {
    if (!canAdministerPlatform(principal).allowed) {
      throw new MarketError(403, "forbidden", "仅平台管理员可以审核上架申请");
    }
  }

  async submit(
    principal: Principal,
    subject: Subject,
    agent: Agent,
    raw: unknown,
  ): Promise<ListingRequest> {
    this.assertOwner(principal, subject, agent);
    const note = text(body(raw).note, "申请说明");
    const published = (await this.deps.releases.publishedOf([agent])).get(agent.id);
    if (!published) throw new MarketError(409, "not_published", "请先发布智能体再申请上架");
    if (agent.marketListed) throw new MarketError(409, "already_listed", "这个智能体已经在市场上");
    const created = await this.deps.repo.create({
      id: this.newId(),
      agentId: agent.id,
      version: published.version,
      requesterId: subject.userId,
      note,
      createdAt: this.now(),
    });
    if (!created) {
      throw new MarketError(409, "pending_exists", "已有一条待审核的上架申请,请等管理员处理");
    }
    return created;
  }

  async latest(
    principal: Principal,
    subject: Subject,
    agent: Agent,
  ): Promise<ListingRequest | null> {
    this.assertOwner(principal, subject, agent);
    return this.deps.repo.latestFor(agent.id);
  }

  async list(principal: Principal, status?: string | null): Promise<ListingRequest[]> {
    this.assertAdmin(principal);
    if (status && !LISTING_REQUEST_STATUSES.includes(status as ListingRequestStatus)) {
      throw new MarketError(400, "invalid_request", "未知的申请状态");
    }
    return this.deps.repo.list({ status: (status || undefined) as ListingRequestStatus });
  }

  async get(principal: Principal, id: string): Promise<ListingRequest> {
    this.assertAdmin(principal);
    const found = await this.deps.repo.get(id);
    if (!found) throw new MarketError(404, "not_found", "上架申请不存在");
    return found;
  }

  /**
   * 通过:先上架(沿用管理员直接上架的同一套校验:必须已发布、类别有效),再把申请标为通过。
   * 顺序如此是因为上架可重复执行,而申请一旦标为通过就不能回到 pending ——
   * 反过来做,上架失败时会留下一条「已通过」却没上架的申请。
   */
  async decide(principal: Principal, id: string, raw: unknown): Promise<ListingRequest> {
    this.assertAdmin(principal);
    const b =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (!b || (b.action !== "approve" && b.action !== "reject")) {
      throw new MarketError(400, "invalid_request", "action 须为 approve 或 reject");
    }
    let category: string | undefined;
    let reason: string | undefined;
    if (b.action === "approve") {
      if (!validCategory(b.category))
        throw new MarketError(400, "invalid_category", "请选择有效类别");
      category = b.category;
    } else {
      reason = text(b.reason, "驳回理由");
      if (!reason) throw new MarketError(400, "invalid_request", "驳回需要写明理由");
    }

    const found = await this.deps.repo.get(id);
    if (!found) throw new MarketError(404, "not_found", "上架申请不存在");
    if (found.status !== "pending") {
      throw new MarketError(409, "not_pending", "这条申请已经处理过了");
    }
    if (category) {
      await this.deps.market.setListing(principal, found.agentId, { listed: true, category });
    }
    const decided = await this.deps.repo.decide(id, {
      status: category ? "approved" : "rejected",
      category,
      reason,
      decidedBy: principal.type === "web" ? principal.userId : "",
      decidedAt: this.now(),
    });
    if (!decided) throw new MarketError(409, "not_pending", "这条申请已经处理过了");
    return decided;
  }
}
