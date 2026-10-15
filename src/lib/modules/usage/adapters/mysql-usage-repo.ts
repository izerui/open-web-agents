import type { Db } from "@/lib/db/client";
import { agents, runs, sessions } from "@/lib/db/schema";
import type { ModelMetering } from "@/lib/modules/agent-engine/domain/model-usage";
import { type RunUsageRecord, toMicroUsd } from "@/lib/modules/usage/domain/aggregate";
import type { RunCreditEstimate } from "@/lib/modules/usage/domain/estimate";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

export interface UsageQuery {
  /**
   * 只统计该账号计费的会话;不传则统计全部(仅 admin 可用)。
   * 口径是 sessions.billing_user_id —— 曾经按 owner_id 统计,API Key 与 embed
   * 产生的花费(这两类会话没有 owner)不算在任何人头上,额度也就拦不住它们。
   */
  ownerId?: string;
  /** 起始时间(ms)。 */
  since: number;
  limit?: number;
}

/** 单次查询的记录数上限。超过即截断,调用方需通过 isTruncated 感知。 */
const DEFAULT_LIMIT = 5000;

export class MysqlUsageRepo {
  constructor(private readonly db: Db) {}

  /**
   * 窗口内的记录数是否已超出上限。
   *
   * 【必须让调用方知道】—— list 有 5000 条上限,而 /api/usage 不传 limit。
   * 窗口内运行数超过它时(默认 7 天,invoke 每次调用产生一条,集成方轻易达到),
   * 聚合出的 totals 其实只是"最新 5000 条的合计",却作为总计呈现,
   * 响应里没有任何截断标志。数字偏小,所以超预算时反而没人会察觉。
   */
  async isTruncated(q: UsageQuery): Promise<boolean> {
    const conds = [gte(runs.createdAt, new Date(q.since))];
    if (q.ownerId) conds.push(eq(sessions.billingUserId, q.ownerId));
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .where(and(...conds));
    return Number(rows[0]?.n ?? 0) > (q.limit ?? DEFAULT_LIMIT);
  }

  /**
   * 拉取窗口内的运行记录,聚合交给纯域函数。
   *
   * 有意不在 SQL 里做聚合:分组口径(按天/按智能体/UTC 边界)属于业务规则,
   * 放在可单测的域层比藏在 SQL 里更容易验证与演进。窗口有上限,不会拉爆内存 ——
   * 但上限意味着结果可能不完整,故配套提供 isTruncated。
   */
  async list(q: UsageQuery): Promise<RunUsageRecord[]> {
    const conds = [gte(runs.createdAt, new Date(q.since))];
    if (q.ownerId) conds.push(eq(sessions.billingUserId, q.ownerId));

    const rows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        cost: runs.cost,
        agentId: sessions.agentId,
        agentName: agents.name,
        ownerId: sessions.billingUserId,
        endedAt: runs.endedAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .leftJoin(agents, eq(sessions.agentId, agents.id))
      .where(and(...conds))
      .orderBy(desc(runs.createdAt))
      .limit(q.limit ?? DEFAULT_LIMIT);

    return rows.map((r) => {
      const cost = (r.cost ?? {}) as {
        usd?: number;
        input?: number;
        output?: number;
        metering?: ModelMetering;
        creditEstimate?: RunCreditEstimate;
      };
      return {
        runId: r.runId,
        agentId: r.agentId,
        agentName: r.agentName ?? undefined,
        ownerId: r.ownerId ?? undefined,
        status: r.status,
        costMicroUsd: toMicroUsd(cost.usd),
        inputTokens: Number(cost.input ?? 0),
        outputTokens: Number(cost.output ?? 0),
        metering: cost.metering,
        creditEstimate: cost.creditEstimate,
        at: (r.endedAt ?? r.createdAt).getTime(),
      };
    });
  }

  /**
   * 按账号聚合窗口内花费(微美元)。账号管理页用。
   *
   * 【为什么在 SQL 里聚合,而不是复用 list()】list 有 5000 条上限,
   * 用它算总额会在活跃平台上悄悄少算 —— 而这里的数字是要拿来做额度判断的,
   * 少算意味着该拦的没拦。聚合下推到 SQL 就没有条数上限。
   *
   * 【为什么要 CAST 成 DECIMAL】cost.usd 是 JSON 里的浮点数,
   * 直接 SUM 会按 DOUBLE 累加,几千条累加下来末位会漂。
   * DECIMAL 是定点数,加多少条都不会引入新的误差。
   *
   * 【为什么一次查完所有账号】账号列表要给每个账号显示花费,
   * 逐个查就是典型的 N+1 —— 一百个账号就是一百次往返。
   */
  async costByOwner(since: number, ownerId?: string): Promise<Map<string, number>> {
    // 【为什么要能只查一个】额度检查在每次运行前都跑一次,
    // 那时只关心当前这一个账号 —— 为它去扫全平台的运行记录是白费的
    const conds = [gte(runs.createdAt, new Date(since)), isNotNull(sessions.billingUserId)];
    if (ownerId) conds.push(eq(sessions.billingUserId, ownerId));

    const rows = await this.db
      .select({
        ownerId: sessions.billingUserId,
        usd: sql<string>`COALESCE(SUM(CAST(JSON_EXTRACT(${runs.cost}, '$.usd') AS DECIMAL(24,10))), 0)`,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .where(and(...conds))
      .groupBy(sessions.billingUserId);

    const out = new Map<string, number>();
    for (const r of rows) {
      if (!r.ownerId) continue;
      // MySQL 的 DECIMAL 经驱动回来是字符串,Number() 到这一步才损失精度 ——
      // 而此时已经加完了,不会再累积
      out.set(r.ownerId, toMicroUsd(Number(r.usd)));
    }
    return out;
  }

  /** 当前排队/在跑的任务数,看板用来判断系统是否积压。 */
  async queueDepth(): Promise<{ pending: number; running: number }> {
    const rows = await this.db
      .select({ status: runs.status, n: sql<number>`COUNT(*)` })
      .from(runs)
      .groupBy(runs.status);
    let pending = 0;
    let running = 0;
    for (const r of rows) {
      if (r.status === "pending") pending = Number(r.n);
      if (r.status === "running") running = Number(r.n);
    }
    return { pending, running };
  }
}
