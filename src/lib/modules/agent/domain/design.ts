import { createHash } from "node:crypto";
import type { Agent, AgentSnapshot } from "../ports";
import { agentToBundle, bundleToAgent } from "./agent-bundle";
import type { AgentConfig } from "./config";
import { redactAgentConfigForReader } from "./config";
import { stableStringify } from "./release";

export interface DesignState {
  /** null 表示创建新的智能体;旧会话没有状态,须显式载入当前草稿后才能保存。 */
  baseHash: string | null;
  resourceAgentIds: string[];
  draft: DesignDraft;
  aiRunId?: string;
  importedRunId?: string;
  aiIssue?: string;
}

export interface DesignDraft {
  name: string;
  description: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
  skillRefs: string[];
  mcpRefs: string[];
}

export interface DesignResource {
  ref: string;
  kind: "skill" | "mcp";
  name: string;
  agentId: string;
  agentName: string;
  description?: string;
}

export const DRAFT_FILE = "design-draft.json";

export function designHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function resourceRef(agentId: string, kind: "skill" | "mcp", name: string): string {
  return JSON.stringify([agentId, kind, name]);
}

export function designResources(agents: Agent[]): DesignResource[] {
  return agents.flatMap((agent) => [
    ...(agent.config.skillPackages ?? []).map((s) => ({
      ref: resourceRef(agent.id, "skill", s.name),
      kind: "skill" as const,
      name: s.name,
      description: s.description,
      agentId: agent.id,
      agentName: agent.name,
    })),
    ...(agent.config.mcpServers ?? []).map((m) => ({
      ref: resourceRef(agent.id, "mcp", m.name),
      kind: "mcp" as const,
      name: m.name,
      agentId: agent.id,
      agentName: agent.name,
    })),
  ]);
}

export function draftOf(agent?: Agent): DesignDraft {
  // 延用智能体包的字段清单,但技能与 MCP 只给引用,不把脚本或连接密钥复制到设计工作区。
  const files = agentToBundle({
    name: agent?.name ?? "",
    description: agent?.description,
    config: agent?.config ?? { systemPrompt: "", model: "sonnet", maxTurns: 20 },
  });
  const {
    name,
    description,
    mcpServers: _mcp,
    ...parameters
  } = JSON.parse(files["agent/agent.json"] ?? "{}");
  return {
    name,
    description,
    systemPrompt: agent?.config.systemPrompt ?? "",
    parameters,
    skillRefs: agent
      ? (agent.config.skillPackages ?? []).map((s) => resourceRef(agent.id, "skill", s.name))
      : [],
    mcpRefs: agent
      ? (agent.config.mcpServers ?? []).map((m) => resourceRef(agent.id, "mcp", m.name))
      : [],
  };
}

export function parseDesign(raw: unknown): DesignDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("设计草稿必须是对象");
  const d = raw as Record<string, unknown>;
  const keys = ["name", "description", "systemPrompt", "parameters", "skillRefs", "mcpRefs"];
  if (Object.keys(d).some((k) => !keys.includes(k))) throw new Error("设计草稿包含不支持的字段");
  for (const k of ["name", "description", "systemPrompt"]) {
    if (typeof d[k] !== "string") throw new Error(`${k} 必须是文本`);
  }
  if (!d.parameters || typeof d.parameters !== "object" || Array.isArray(d.parameters)) {
    throw new Error("parameters 必须是对象");
  }
  for (const k of ["skillRefs", "mcpRefs"]) {
    if (!Array.isArray(d[k]) || d[k].some((v) => typeof v !== "string")) {
      throw new Error(`${k} 必须是资源引用列表`);
    }
    if (new Set(d[k]).size !== d[k].length) throw new Error(`${k} 有重复引用`);
  }
  if (JSON.stringify(raw).length > 500_000) throw new Error("设计草稿过大");
  return d as unknown as DesignDraft;
}

/** 只从当前仍有权限的资源解析配置;AI 不能注入技能正文、MCP 密钥或逃生舱。 */
export function resolveDesign(draft: DesignDraft, resources: Agent[]): AgentSnapshot {
  const forbidden = [
    "name",
    "description",
    "systemPrompt",
    "skills",
    "skillPackages",
    "mcpServers",
    "escapeHatch",
  ];
  if (forbidden.some((k) => k in draft.parameters))
    throw new Error("parameters 不能包含资源正文、MCP 或受保护字段");
  const parsed = bundleToAgent({
    "agent/agent.json": JSON.stringify({
      ...draft.parameters,
      name: draft.name,
      description: draft.description,
    }),
    "agent/system-prompt.md": draft.systemPrompt,
  });
  if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; "));
  const skills = new Map(
    resources.flatMap((a) =>
      (a.config.skillPackages ?? []).map((s) => [resourceRef(a.id, "skill", s.name), s] as const),
    ),
  );
  const mcps = new Map(
    resources.flatMap((a) =>
      (a.config.mcpServers ?? []).map((m) => [resourceRef(a.id, "mcp", m.name), m] as const),
    ),
  );
  const choose = <T extends { name: string }>(refs: string[], available: Map<string, T>): T[] => {
    const found = refs.map((ref) => {
      const value = available.get(ref);
      if (!value) throw new Error("资源已变化或无权使用,请重新选择 Skills/MCP");
      return structuredClone(value);
    });
    if (new Set(found.map((v) => v.name)).size !== found.length)
      throw new Error("选中的资源名称重复");
    return found;
  };
  return {
    name: parsed.agent.name,
    description: parsed.agent.description,
    config: {
      ...parsed.agent.config,
      skillPackages: choose(draft.skillRefs, skills),
      mcpServers: choose(draft.mcpRefs, mcps),
    },
  };
}

/** 差异只显示资源名字和安全配置,绝不把已有脚本与 MCP 凭证带回设计器。 */
export function designSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const cfg = redactAgentConfigForReader(snapshot.config);
  return {
    ...snapshot,
    config: {
      ...cfg,
      skillPackages: cfg.skillPackages?.map((s) => ({ ...s, files: {} })),
      mcpServers: cfg.mcpServers?.map((m) => ({ name: m.name, type: m.type })),
    } as AgentConfig,
  };
}
