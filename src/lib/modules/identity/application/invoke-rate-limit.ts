// invoke 的调用限流:每把 API Key、每个智能体各一个每分钟的固定窗口。
//
// 只约束【新开一次运行】的请求 —— 路由在幂等重放之后才调用它。重放不产生新的执行与花费,
// 限流拦它只会让调用方拿不回已经受理的任务。
//
// 两层的分工:
// - 每把 Key:防一个对接方的死循环把签发人的额度在几分钟内烧光(额度是月度的,反应太慢);
// - 每个智能体(所有 Key 合计):防多个对接方同时压垮同一个智能体,挤占 worker。

import type { RateLimitVerdict, RateLimiter } from "@/lib/modules/identity/ports";

export const INVOKE_WINDOW_MS = 60_000;

export interface InvokeRateInput {
  keyId: string;
  /** 这把 Key 单独设的上限;undefined = 平台默认 */
  keyLimit?: number;
  agentId: string;
  /** 平台默认的每 Key 上限;0 = 不限 */
  defaultKeyLimit: number;
  /** 每个智能体的上限;0 = 不限 */
  agentLimit: number;
}

/** 回给调用方的配额信息(按这把 Key 计)。 */
export interface RateInfo {
  limit: number;
  remaining: number;
  resetMs: number;
}

export type InvokeRateVerdict =
  | { allowed: true; key?: RateInfo }
  | { allowed: false; scope: "key" | "agent"; limit: number; retryAfterMs: number };

export async function checkInvokeRate(
  limiter: RateLimiter,
  input: InvokeRateInput,
): Promise<InvokeRateVerdict> {
  const keyLimit = input.keyLimit ?? input.defaultKeyLimit;

  // 先查 Key 自己的:被它拒掉的请求不该再占用智能体的公共配额
  let keyVerdict: RateLimitVerdict | undefined;
  if (keyLimit > 0) {
    keyVerdict = await limiter.hit(`invoke:key:${input.keyId}`, keyLimit, INVOKE_WINDOW_MS);
    if (!keyVerdict.allowed) {
      return {
        allowed: false,
        scope: "key",
        limit: keyLimit,
        retryAfterMs: keyVerdict.retryAfterMs,
      };
    }
  }
  if (input.agentLimit > 0) {
    const v = await limiter.hit(
      `invoke:agent:${input.agentId}`,
      input.agentLimit,
      INVOKE_WINDOW_MS,
    );
    if (!v.allowed) {
      return {
        allowed: false,
        scope: "agent",
        limit: input.agentLimit,
        retryAfterMs: v.retryAfterMs,
      };
    }
  }
  return {
    allowed: true,
    key: keyVerdict
      ? { limit: keyLimit, remaining: keyVerdict.remaining, resetMs: keyVerdict.resetMs }
      : undefined,
  };
}

/**
 * 这把 Key 能设的上限。
 * 普通用户只能把自己的 Key 调得比平台默认更严(默认关闭时不设上限);管理员不受限。
 */
export function validateKeyRateLimit(
  value: unknown,
  opts: { isAdmin: boolean; platformDefault: number },
): { ok: true; value: number | null } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    return { ok: false, reason: "rateLimitPerMinute 须为 1~100000 的整数,或 null 恢复平台默认" };
  }
  if (!opts.isAdmin && opts.platformDefault > 0 && value > opts.platformDefault) {
    return {
      ok: false,
      reason: `rateLimitPerMinute 不能高于平台默认的每分钟 ${opts.platformDefault} 次;需要更高请联系管理员`,
    };
  }
  return { ok: true, value };
}

/** 响应头:成功与 429 都带,调用方据此自我节流。 */
export function rateLimitHeaders(info: RateInfo): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(info.limit),
    "X-RateLimit-Remaining": String(info.remaining),
    "X-RateLimit-Reset": String(Math.ceil(info.resetMs / 1000)),
  };
}
