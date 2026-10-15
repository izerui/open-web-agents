import type { Grant, Subject } from "@/lib/modules/access/domain/grants";
import {
  type Principal,
  canAdministerPlatform,
  canInvokeAgent,
  isMarketUsable,
} from "@/lib/modules/access/domain/principal";
import type { AgentReleases } from "@/lib/modules/agent/application/releases";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";
import type { AgentRepo } from "@/lib/modules/agent/ports";
import { BrandedError } from "@/lib/shared";
import { marketSummary, validCategory } from "../domain/catalog";

export class MarketError extends BrandedError {
  static readonly brand = Symbol.for("owa.error.MarketError");

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AgentMarket {
  constructor(
    private readonly agents: AgentRepo,
    private readonly releases: Pick<AgentReleases, "publishedOf">,
  ) {}

  async list(
    principal: Principal,
    subject: Subject,
    grants: Grant[],
    query: {
      search?: string;
      category?: string;
      manage?: boolean;
    } = {},
  ) {
    if (query.manage && !canAdministerPlatform(principal).allowed) {
      throw new MarketError(403, "forbidden", "仅平台管理员可以管理市场");
    }
    if (query.category && !validCategory(query.category)) {
      throw new MarketError(400, "invalid_category", "未知类别");
    }
    const agents = (
      await this.agents.list(query.manage ? { includePublished: true } : { includeMarket: true })
    ).filter(
      (a) =>
        !isSystemAgent(a.id) &&
        a.publishedVersion !== undefined &&
        (query.manage || isMarketUsable(a)) &&
        canInvokeAgent(principal, a, subject, grants).allowed,
    );
    const versions = await this.releases.publishedOf(agents);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    return agents
      .flatMap((agent) => {
        const version = versions.get(agent.id);
        if (!version) return [];
        const item = marketSummary(agent, version);
        if (query.category && item.category !== query.category) return [];
        if (
          search &&
          !`${item.name}\n${item.description ?? ""}`.toLocaleLowerCase().includes(search)
        )
          return [];
        return [item];
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async detail(principal: Principal, subject: Subject, grants: Grant[], id: string) {
    const agent = await this.agents.get(id);
    if (
      !agent ||
      !isMarketUsable(agent) ||
      !canInvokeAgent(principal, agent, subject, grants).allowed
    ) {
      throw new MarketError(404, "not_found", "市场智能体不存在或已下架");
    }
    const published = (await this.releases.publishedOf([agent])).get(id);
    if (!published) throw new MarketError(404, "not_found", "已发布版本不存在");
    return marketSummary(agent, published);
  }

  async setListing(principal: Principal, id: string, raw: unknown) {
    if (!canAdministerPlatform(principal).allowed) {
      throw new MarketError(403, "forbidden", "仅平台管理员可以上下架");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MarketError(400, "invalid_request", "上架参数必须是对象");
    }
    const body = raw as Record<string, unknown>;
    if (
      typeof body.listed !== "boolean" ||
      !validCategory(body.category) ||
      Object.keys(body).some((key) => key !== "listed" && key !== "category")
    ) {
      throw new MarketError(400, "invalid_request", "须指定上架状态和有效类别");
    }
    const agent = await this.agents.get(id);
    if (!agent || isSystemAgent(id)) throw new MarketError(404, "not_found", "智能体不存在");
    if (body.listed && !(await this.releases.publishedOf([agent])).has(id)) {
      throw new MarketError(409, "not_published", "请先发布智能体");
    }
    const listing = { listed: body.listed, category: body.category };
    if (!(await this.agents.setMarketListing(id, listing))) {
      throw new MarketError(409, "agent_changed", "智能体已变化，请刷新后重试");
    }
    return { id, ...listing };
  }
}
