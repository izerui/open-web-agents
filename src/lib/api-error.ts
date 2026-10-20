// 对外接口的错误响应格式:{ error: 人读的说明, code: 机读的稳定代码, ...附加字段 }
//
// 【为什么要 code】error 是给人看的中文说明,会改措辞;集成方不能靠匹配文案来分支处理。
// code 一旦发布就不改含义。

import { ChargeRejected } from "@/lib/modules/billing/application/run-charging";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  /** 版本冲突或唯一性冲突:刷新后重试 */
  | "conflict"
  | "invalid_request"
  | "input_invalid"
  | "prompt_too_large"
  /** 积分可用余额不足 */
  | "insufficient_balance"
  /** 账号本月积分上限已用完 */
  | "account_limit_exceeded"
  /** 这把 API Key 本月积分上限已用完 */
  | "key_limit_exceeded"
  /** 账号的旧美元月度上限待管理员按积分重新设置 */
  | "account_limit_pending"
  /** 历史会话没有可记账的账号 */
  | "billing_account_missing"
  | "rate_limited"
  | "idempotency_key_invalid"
  | "idempotency_conflict"
  | "nothing_to_publish"
  | "limit_exceeded"
  | "service_unavailable"
  /** 运行没有在接受追加消息(还没开始或已收尾),这条没有受理 */
  | "not_accepting"
  /** 追加消息受理了,但运行在交给模型前结束了 */
  | "dropped"
  /** "从某一轮重来"无法精确定位那一轮之前的状态(旧数据) */
  | "rewind_unavailable";

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: HeadersInit,
): Response {
  return Response.json({ error: message, code, ...extra }, { status, headers });
}

/**
 * 计费受理被拒翻成 402;不是就返回 null 交给调用方。
 * 402 而非 429:余额或月度上限不是"等一会儿再试"能解决的,客户端不该退避重试。
 */
export function chargeErrorResponse(err: unknown): Response | null {
  if (!(err instanceof ChargeRejected)) return null;
  return apiError(402, err.code, err.message);
}
