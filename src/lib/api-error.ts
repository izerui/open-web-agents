// 对外接口的错误响应格式:{ error: 人读的说明, code: 机读的稳定代码, ...附加字段 }
//
// 【为什么要 code】error 是给人看的中文说明,会改措辞;集成方不能靠匹配文案来分支处理。
// code 一旦发布就不改含义。

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "input_invalid"
  | "prompt_too_large"
  | "quota_exceeded"
  | "rate_limited"
  | "idempotency_key_invalid"
  | "idempotency_conflict"
  | "nothing_to_publish"
  | "limit_exceeded"
  | "service_unavailable"
  /** 运行没有在接受追加消息(还没开始或已收尾),这条没有受理 */
  | "not_accepting"
  /** 追加消息受理了,但运行在交给模型前结束了 */
  | "dropped";

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: HeadersInit,
): Response {
  return Response.json({ error: message, code, ...extra }, { status, headers });
}
