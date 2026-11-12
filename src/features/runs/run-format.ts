// 运行记录的展示判断:纯函数,便于测试。

import { compactCount } from "@/features/usage/usage-display";

export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms} 毫秒`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 只有还没结束的运行能取消(POST /api/runs/[id]/cancel) */
export function canCancelRun(status: RunStatus): boolean {
  return status === "pending" || status === "running";
}

export function versionLabel(version?: number): string {
  return version ? `v${version}` : "草稿";
}

export function tokensText(cost?: { input?: number; output?: number }): string | null {
  const total = (cost?.input ?? 0) + (cost?.output ?? 0);
  return total > 0 ? `${compactCount(total)} tokens` : null;
}

export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/** 结构化入参(JSON)美化显示;解析不了就原样 */
export function prettyInput(text: string): string {
  if (!looksLikeJson(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
