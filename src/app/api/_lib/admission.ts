import { type ApiErrorCode, apiError } from "@/lib/api-error";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { type AdmissionCaller, AdmissionRejected } from "@/lib/modules/run/application/admission";

/** 访问控制的主体 → 受理用的调用方(API Key 带上它单独设的限额)。 */
export function callerOf(p: Principal): AdmissionCaller {
  return p.type === "web"
    ? { type: "web", userId: p.userId }
    : {
        type: "apiKey",
        keyId: p.keyId,
        ownerId: p.ownerId,
        rateLimitPerMinute: p.rateLimitPerMinute,
      };
}

/** 受理被拒 → 统一的 { error, code } 响应;不是受理异常返回 null。 */
export function admissionErrorResponse(err: unknown): Response | null {
  if (!(err instanceof AdmissionRejected)) return null;
  return apiError(err.status, err.code as ApiErrorCode, err.message, err.extra, err.headers);
}
