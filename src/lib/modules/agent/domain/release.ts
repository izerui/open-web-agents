// 智能体版本与发布的纯规则。
//
// 【为什么要有发布】智能体被企业系统当接口调用后,"保存即生效"就成了隐患:
// 作者改一句提示词、调一下 outputSchema,正在线上调用的系统立刻拿到不同的结果,
// 而且事后说不清是哪一版配置产出的。现在草稿随便改,对外入口只跑发布过的版本;
// 回滚是把发布指针指回旧版本,秒级生效。

import { createHash } from "node:crypto";
import type { Agent, AgentSnapshot } from "@/lib/modules/agent/ports";

/** 键排序后的 JSON:同样的内容不论字段顺序,摘要都相同。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
}

/** 从智能体当前的草稿取出要冻结的内容。 */
export function snapshotOf(agent: Agent): AgentSnapshot {
  return {
    name: agent.name,
    icon: agent.icon,
    description: agent.description,
    config: structuredClone(agent.config),
  };
}

export function contentHash(s: AgentSnapshot): string {
  return createHash("sha256").update(stableStringify(s)).digest("hex");
}

/** 草稿与已发布版本不同(从未发布的智能体不算 —— 它没有"已发布"可比)。 */
export function hasUnpublishedChanges(agent: Agent): boolean {
  if (agent.publishedVersion === undefined) return false;
  return contentHash(snapshotOf(agent)) !== agent.publishedHash;
}

/** 调用方指定的版本号:正整数。 */
export function parseVersion(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return { ok: false };
  return { ok: true, value: n };
}
