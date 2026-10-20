// 停用模型 / 提供者前的影响面:有多少智能体(草稿或当前发布版本)会用到它。纯函数。
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { MODEL_ALIASES, type ModelAlias, isModelAlias } from "@/lib/shared";
import type { ModelAliases } from "./provider";

export interface AgentModelRefsRow {
  agentId: string;
  /** 草稿与当前发布版本里出现过的主模型、子代理模型引用 */
  refs: string[];
}

export type ImpactTarget = { capabilityId: string } | { providerId: string };

export interface Impact {
  agents: number;
  /** 别名映射指向目标的别名(经别名引用的智能体已计入 agents) */
  aliases: ModelAlias[];
}

export function countImpact(
  rows: AgentModelRefsRow[],
  aliases: ModelAliases | null,
  models: Capability[],
  target: ImpactTarget,
): Impact {
  const providerOf = new Map(models.map((m) => [m.id, m.providerId]));
  const hits = (capabilityId: string | undefined) =>
    !!capabilityId &&
    ("capabilityId" in target
      ? capabilityId === target.capabilityId
      : providerOf.get(capabilityId) === target.providerId);
  const resolve = (ref: string) => (isModelAlias(ref) ? aliases?.[ref] : ref);

  const agents = rows.filter((row) => row.refs.some((ref) => hits(resolve(ref)))).length;
  return {
    agents,
    aliases: aliases ? MODEL_ALIASES.filter((a) => hits(aliases[a])) : [],
  };
}
