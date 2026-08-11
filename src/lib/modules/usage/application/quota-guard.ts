import { type QuotaVerdict, evaluateQuota } from "@/lib/modules/usage/domain/quota";

/** 超出月度额度。路由把它翻成 402。 */
export class QuotaExceeded extends Error {
  constructor(
    message: string,
    readonly verdict: QuotaVerdict,
  ) {
    super(message);
    this.name = "QuotaExceeded";
  }
}

/** 本月起点(UTC)。额度按自然月重置。 */
export function monthStartUtc(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * 这一关需要的最小依赖。
 *
 * 【为什么不直接写 UserRepo / MysqlUsageRepo】架构测试(architecture.test.ts)
 * 禁止模块之间直接 import 对方的内部端口 —— 我第一版写成 `users: UserRepo`,
 * 它当场就报了 `usage → identity/user-ports`。这个约束是对的:
 * 额度判断只需要"能查到某个账号的额度上限",不需要认识 identity 模块。
 * 按结构声明需求,容器里传进来的 UserRepo 自然满足它。
 */
export interface QuotaDeps {
  users: { get(id: string): Promise<{ monthlyQuotaMicroUsd?: number } | null> };
  usage: { costByOwner(since: number, ownerId?: string): Promise<Map<string, number>> };
}

/**
 * 发起运行前的额度关卡。
 *
 * 【为什么要在这里拦,而不是靠事后统计】这是一个按量计费的平台,
 * 一次运行可能跑很久、烧掉可观的额度。事后发现超支只能追认,
 * 拦在发起之前才是"上限"这个词的意思。
 *
 * 【为什么先读账号再决定要不要查花费】绝大多数账号没设额度,
 * 那条路径上一次聚合查询都不该发生 —— 额度检查不能变成
 * 每次运行都多一次全表扫描的固定开销。
 */
export async function assertWithinQuota(deps: QuotaDeps, ownerId: string): Promise<QuotaVerdict> {
  const user = await deps.users.get(ownerId);
  const limit = user?.monthlyQuotaMicroUsd;
  if (limit === undefined || limit === null) {
    return { allowed: true, usedMicroUsd: 0 };
  }

  const costs = await deps.usage.costByOwner(monthStartUtc(), ownerId);
  const verdict = evaluateQuota(costs.get(ownerId) ?? 0, limit);
  if (!verdict.allowed) {
    throw new QuotaExceeded(verdict.reason ?? "超出月度额度", verdict);
  }
  return verdict;
}

/**
 * 把额度异常翻成 HTTP 响应;不是额度异常就返回 null 交给调用方。
 *
 * 【为什么是 402 而不是 429】429 的语义是"太快了,等会儿再来",
 * 客户端会退避重试。而月度额度要等到下个月,重试多少次都没用。
 * 402 Payment Required 正是为这种情况准备的。
 */
export function quotaErrorResponse(err: unknown): Response | null {
  if (!(err instanceof QuotaExceeded)) return null;
  return Response.json(
    {
      error: err.message,
      quota: {
        usedMicroUsd: err.verdict.usedMicroUsd,
        limitMicroUsd: err.verdict.limitMicroUsd,
      },
    },
    { status: 402 },
  );
}
