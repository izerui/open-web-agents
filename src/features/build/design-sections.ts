// 智能体设计器(gaps A4 / A7)的纯逻辑:把设计器的改动按档案卡的节拆开、只取某几节组合成一次保存,
// 以及拼给设计器的提示词(评测失败修复、试运行反馈)。
//
// 【为什么前端拆节】设计器的保存接口(/api/agents/design/apply)只认整份设计草稿,且用 previewToken
// 绑定「用户看过的那份差异」、用基线哈希挡住并发修改。按节应用时,前端把「基线 + 这几节的提议」
// 组合成一份草稿写回设计会话,重新预览拿到新的 previewToken 再 apply —— 安全语义一点不少。

import type { DesignDraft } from "@/lib/modules/agent/domain/design";
import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import { SECTIONS, type SectionKey } from "./profile-model";

/** 设计器能改到的节(知识与 Webhook 不在设计草稿里) */
export type DesignSection = Exclude<SectionKey, "knowledge" | "webhook">;

/** 配置参数 → 节;不认识的参数归「模型」(高级参数在那一节) */
const PARAM_SECTION: Record<string, DesignSection> = {
  starters: "identity",
  systemPrompt: "prompt",
  model: "model",
  maxTurns: "model",
  effort: "model",
  tools: "ability",
  subagents: "ability",
  skillPackages: "ability",
  mcpServers: "ability",
  variables: "vars",
  inputSchema: "contract",
  outputSchema: "contract",
  permissionMode: "approval",
  approvalRules: "approval",
  unattendedApproval: "approval",
};

const paramSection = (key: string): DesignSection => PARAM_SECTION[key] ?? "model";

/** 差异路径(见 snapshot-diff:name / description / icon / config.<键>…)所属的节 */
export function sectionOfChangePath(path: string): DesignSection {
  if (path === "name" || path === "description" || path === "icon") return "identity";
  const m = /^config\.([A-Za-z0-9_]+)/.exec(path);
  return m?.[1] ? paramSection(m[1]) : "model";
}

const ORDER = SECTIONS.map((s) => s.key);

export function groupChanges(
  changes: SnapshotChange[],
): { section: DesignSection; changes: SnapshotChange[] }[] {
  const by = new Map<DesignSection, SnapshotChange[]>();
  for (const c of changes) {
    const s = sectionOfChangePath(c.path);
    by.set(s, [...(by.get(s) ?? []), c]);
  }
  return [...by.entries()]
    .sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([section, list]) => ({ section, changes: list }));
}

/** 设计草稿顶层字段 → 节 */
const TOP_SECTION: Record<string, DesignSection> = {
  name: "identity",
  description: "identity",
  systemPrompt: "prompt",
  skillRefs: "ability",
  mcpRefs: "ability",
  skillPackages: "ability",
  mcpServers: "ability",
};

/**
 * 从提议里只取 take 这几节,其余保持基线。
 * requireIdentity:新建(还没有目标智能体)时名称必须一起带上,否则保存不进去。
 */
export function mergeDesignSections(
  base: DesignDraft,
  proposal: DesignDraft,
  take: readonly DesignSection[],
  opts: { requireIdentity?: boolean } = {},
): DesignDraft {
  const sections = new Set<DesignSection>(take);
  if (opts.requireIdentity) sections.add("identity");
  const out: Record<string, unknown> = { ...base };
  for (const [key, section] of Object.entries(TOP_SECTION)) {
    if (!sections.has(section)) continue;
    const v = (proposal as unknown as Record<string, unknown>)[key];
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  const params: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base.parameters), ...Object.keys(proposal.parameters)]);
  for (const k of keys) {
    const from = sections.has(paramSection(k)) ? proposal.parameters : base.parameters;
    if (from[k] !== undefined) params[k] = from[k];
  }
  out.parameters = params;
  return out as unknown as DesignDraft;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** 提议与基线不同的节(按档案卡顺序) */
export function changedSections(base: DesignDraft, draft: DesignDraft): DesignSection[] {
  const pick = (d: DesignDraft, s: DesignSection) =>
    stable(mergeDesignSections({ ...EMPTY, parameters: {} }, d, [s]));
  return (ORDER.filter((k) => k !== "knowledge" && k !== "webhook") as DesignSection[]).filter(
    (s) => pick(base, s) !== pick(draft, s),
  );
}

const EMPTY: DesignDraft = {
  name: "",
  description: "",
  systemPrompt: "",
  parameters: {},
  skillRefs: [],
  mcpRefs: [],
};

/** 与服务端 EvalOutput 同形(见 eval/domain/assertions.ts) */
export interface EvalOutputLite {
  status: string;
  text?: string;
  textTruncated?: boolean;
  structured?: unknown;
  structuredPreview?: string;
  error?: string;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** A7「让设计器修复」:把失败用例的输入、输出快照、断言与原因拼成一段提示词 */
export function evalFixPrompt(
  cases: {
    caseName: string;
    input: unknown;
    assertions: string;
    failures?: string[];
    output?: EvalOutputLite;
  }[],
): string {
  const parts = [`评测有 ${cases.length} 个评测用例没有通过，请分析原因并修改草稿，让它们通过：`];
  for (const c of cases) {
    const lines = [
      `【用例】${c.caseName}`,
      `【输入】\n${show(c.input)}`,
      `【断言】${c.assertions}`,
    ];
    const o = c.output;
    if (o) {
      if (o.error) lines.push(`【运行错误】${o.error}`);
      if (o.structured !== undefined) lines.push(`【结构化输出】\n${show(o.structured)}`);
      else if (o.structuredPreview) lines.push(`【结构化输出（截断）】\n${o.structuredPreview}`);
      if (o.text) lines.push(`【正文输出】\n${o.text.slice(0, 2000)}`);
    }
    if (c.failures?.length) lines.push(`【未通过原因】\n${c.failures.join("\n")}`);
    parts.push(lines.join("\n"));
  }
  parts.push("请分析原因并修改草稿；只改需要改的部分，改完说明改了什么。");
  return parts.join("\n\n");
}

/** 「从试运行结果反馈」:把一次运行的输入、输出与错误拼成提示词(与原 AI 编辑同一格式) */
export function trialFeedbackPrompt(run: {
  promptPreview: string;
  text?: string;
  structured?: string;
  error?: { kind?: string; message?: string };
}): string {
  const parts = ["基于以下试运行结果改进智能体配置：\n"];
  parts.push(`【输入】\n${run.promptPreview}\n`);
  if (run.text) parts.push(`【输出】\n${run.text}\n`);
  if (run.structured) parts.push(`【结构化结果】\n${run.structured}\n`);
  if (run.error) parts.push(`【错误】\n${run.error.message ?? run.error.kind ?? "未知错误"}\n`);
  parts.push("请分析问题并修改草稿。");
  return parts.join("\n");
}

const PATH_LABEL: Record<string, string> = {
  name: "名称",
  description: "描述",
  icon: "头像",
  systemPrompt: "提示词",
  model: "模型",
  maxTurns: "最大轮次",
  effort: "推理强度",
  tools: "工具白名单",
  skillPackages: "技能包",
  mcpServers: "MCP 服务",
  subagents: "子代理",
  variables: "变量",
  inputSchema: "输入契约",
  outputSchema: "输出契约",
  permissionMode: "权限模式",
  approvalRules: "审批规则",
  unattendedApproval: "无人值守审批",
  starters: "开场建议",
  escapeHatch: "逃生舱",
};

/** 差异路径 → 人能看懂的位置,如「技能包 invoice-ocr，files.SKILL.md」 */
export function changeLabel(path: string): string {
  const p = path.replace(/^config\./, "");
  const m = /^([A-Za-z0-9_]+)(?:\[([^\]]+)\])?(?:\.(.*))?$/.exec(p);
  if (!m?.[1]) return path;
  const head = PATH_LABEL[m[1]] ?? m[1];
  return `${head}${m[2] ? ` ${m[2]}` : ""}${m[3] ? `，${m[3]}` : ""}`;
}
