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
  | "service_unavailable";

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: HeadersInit,
): Response {
  return Response.json({ error: message, code, ...extra }, { status, headers });
}
