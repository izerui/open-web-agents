// 运行记录的展示判断:纯函数,便于测试。

import { compactCount } from "@/features/usage/usage-display";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";

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

/**
 * 运行花费:一律显示积分(实际扣除;还在冻结的写明冻结),不退回显示美元。没有扣费记录时:已结束的写「未计费」(计费上线前的旧运行、未开计费),
 * 还没结束或不知道状态的返回 null,不下结论。
 */
export function runCreditsText(
  credits?: { micro: string; state: string },
  status?: RunStatus,
): string | null {
  if (!credits) {
    return status === "success" || status === "failed" || status === "cancelled" ? "未计费" : null;
  }
  const amount = `${creditsAmount(credits.micro)} 积分`;
  return credits.state === "open" ? `冻结 ${amount}` : amount;
}

/** 接口调用和评测不产生可在对话里查看的会话,其余来源都能在对话里打开 */
export function hasChatTranscript(source: string): boolean {
  return source !== "invoke" && source !== "eval";
}
