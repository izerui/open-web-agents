import { createHash } from "node:crypto";
import type { McpDef, SkillPackage } from "@/lib/shared";
import type { Agent, AgentSnapshot } from "../ports";
import { agentToBundle, bundleToAgent } from "./agent-bundle";
import type { AgentConfig } from "./config";
import { redactAgentConfigForClone, redactAgentConfigForReader } from "./config";
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
  /** AI 直接生成或从已有智能体载入的技能包。与 skillRefs 引用的合并，同名 inline 优先。 */
  skillPackages?: SkillPackage[];
  /** AI 直接生成或从已有智能体载入的 MCP 定义。凭证使用 {{变量名}} 引用。 */
  mcpServers?: McpDef[];
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
  const files = agentToBundle({
    name: agent?.name ?? "",
    description: agent?.description,
    config: agent?.config ?? { systemPrompt: "", model: "sonnet", maxTurns: 20 },
  });
  const {
    name,
    description,
    mcpServers: _mcp,
    skillPackages: _skills,
    ...parameters
  } = JSON.parse(files["agent/agent.json"] ?? "{}");
  const redactedConfig = agent ? redactAgentConfigForClone(agent.config) : undefined;
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
    skillPackages: agent?.config.skillPackages,
    mcpServers: redactedConfig?.mcpServers,
  };
}

export function parseDesign(raw: unknown): DesignDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("设计草稿必须是对象");
  const d = raw as Record<string, unknown>;
  const keys = [
    "name",
    "description",
    "systemPrompt",
    "parameters",
    "skillRefs",
    "mcpRefs",
    "skillPackages",
    "mcpServers",
  ];
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
  if (d.skillPackages !== undefined && !Array.isArray(d.skillPackages)) {
    throw new Error("skillPackages 必须是数组");
  }
  if (d.mcpServers !== undefined && !Array.isArray(d.mcpServers)) {
    throw new Error("mcpServers 必须是数组");
  }
  if (JSON.stringify(raw).length > 500_000) throw new Error("设计草稿过大");
  return d as unknown as DesignDraft;
}

/** 从 inline 定义和资源引用合并技能与 MCP，inline 同名优先。 */
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

  const refSkills = new Map(
    resources.flatMap((a) =>
      (a.config.skillPackages ?? []).map((s) => [resourceRef(a.id, "skill", s.name), s] as const),
    ),
  );
  const refMcps = new Map(
    resources.flatMap((a) =>
      (a.config.mcpServers ?? []).map((m) => [resourceRef(a.id, "mcp", m.name), m] as const),
    ),
  );

  // Refs take priority (they have unredacted content from authorized resources).
  // Inline adds resources that have no matching ref (AI-generated new content).
  const refSkillNames = new Set<string>();
  const resolvedSkills: import("@/lib/shared").SkillPackage[] = [];
  for (const ref of draft.skillRefs) {
    const s = refSkills.get(ref);
    if (!s) throw new Error("资源已变化或无权使用,请重新选择 Skills/MCP");
    if (refSkillNames.has(s.name)) throw new Error(`引用的技能名称 ${s.name} 重复`);
    resolvedSkills.push(structuredClone(s));
    refSkillNames.add(s.name);
  }
  for (const s of draft.skillPackages ?? []) {
    if (!refSkillNames.has(s.name)) resolvedSkills.push(s);
  }

  const refMcpNames = new Set<string>();
  const resolvedMcps: import("@/lib/shared").McpDef[] = [];
  for (const ref of draft.mcpRefs) {
    const m = refMcps.get(ref);
    if (!m) throw new Error("资源已变化或无权使用,请重新选择 Skills/MCP");
    if (refMcpNames.has(m.name)) throw new Error(`引用的 MCP 名称 ${m.name} 重复`);
    resolvedMcps.push(structuredClone(m));
    refMcpNames.add(m.name);
  }
  for (const m of draft.mcpServers ?? []) {
    if (!refMcpNames.has(m.name)) resolvedMcps.push(m);
  }

  return {
    name: parsed.agent.name,
    description: parsed.agent.description,
    config: {
      ...parsed.agent.config,
      skillPackages: resolvedSkills.length > 0 ? resolvedSkills : undefined,
      mcpServers: resolvedMcps.length > 0 ? resolvedMcps : undefined,
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
