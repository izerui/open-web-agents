import { apiError } from "@/lib/api-error";
import type { Subject } from "@/lib/modules/access/domain/grants";
import { stableStringify } from "@/lib/modules/agent/domain/release";

/**
 * 逃生舱只有平台管理员能改。回滚、载入草稿会把某个旧版本的逃生舱带回来 ——
 * 管理员后来出于安全原因撤掉的设置,不能被普通作者借"回滚"恢复。
 * 两边相同(没有实际改动)时放行。
 */
export function escapeHatchChangeDenied(
  subject: Subject,
  from: unknown,
  to: unknown,
): Response | null {
  if (subject.role === "admin") return null;
  if (stableStringify(from ?? null) === stableStringify(to ?? null)) return null;
  return apiError(
    403,
    "forbidden",
    "这个版本的逃生舱(escapeHatch)与当前不同,只有平台管理员可以切换到它",
  );
}
