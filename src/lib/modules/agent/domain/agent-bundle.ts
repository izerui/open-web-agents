// 智能体包:智能体定义 ⇄ 一组文本文件。纯逻辑,零 IO。
//
// 【为什么需要】"AI 智能体设计师"在自己的工作目录里编辑这组文件来设计智能体,
// 平台在用户点"应用"时再把文件解析回配置、按正式规则校验后写入。
// 设计师不直接调用平台接口改配置:改动要经过人确认,对话里混进来的指令也改不了配置。
//
//   agent/agent.json               名称、描述、模型、MCP、子代理、契约、开场建议…
//   agent/system-prompt.md         系统提示词
//   agent/skills/<名称>/SKILL.md    技能正文;frontmatter 写 description
//   agent/skills/<名称>/<其它文件>   技能附带的脚本、模板

import type { SkillPackage } from "@/lib/shared";
import type { AgentConfig } from "./config";

export const BUNDLE_DIR = "agent";

/** agent.json 里允许出现的配置字段。提示词与技能各有专门的文件,不在这里。 */
const JSON_FIELDS = [
  "model",
  "maxTurns",
  "effort",
  "permissionMode",
  "unattendedApproval",
  "starters",
  "tools",
  "mcpServers",
  "subagents",
  "approvalRules",
  "inputSchema",
  "outputSchema",
] as const satisfies readonly (keyof AgentConfig)[];

export interface BundleAgent {
  name: string;
  description?: string;
  config: AgentConfig;
}

/** 智能体 → 文件(相对工作目录的路径 → 内容)。 */
export function agentToBundle(agent: BundleAgent): Record<string, string> {
  const json: Record<string, unknown> = { name: agent.name, description: agent.description ?? "" };
  for (const k of JSON_FIELDS) {
    const v = agent.config[k];
    if (v !== undefined) json[k] = v;
  }
  const files: Record<string, string> = {
    [`${BUNDLE_DIR}/agent.json`]: `${JSON.stringify(json, null, 2)}\n`,
    [`${BUNDLE_DIR}/system-prompt.md`]: `${agent.config.systemPrompt ?? ""}\n`,
  };
  for (const pkg of agent.config.skillPackages ?? []) {
    for (const [rel, content] of Object.entries(pkg.files)) {
      files[`${BUNDLE_DIR}/skills/${pkg.name}/${rel}`] =
        rel === "SKILL.md" ? withFrontmatter(pkg.description, content) : content;
    }
  }
  return files;
}

export type BundleResult =
  | { ok: true; agent: BundleAgent }
  | { ok: false; issues: { field: string; message: string }[] };

/** 文件 → 智能体。只做结构解析;配置合法性由 validateAgentConfig 负责。 */
export function bundleToAgent(files: Record<string, string>): BundleResult {
  const issues: { field: string; message: string }[] = [];
  const raw = files[`${BUNDLE_DIR}/agent.json`];
  if (raw === undefined) {
    return {
      ok: false,
      issues: [{ field: "agent.json", message: `缺少 ${BUNDLE_DIR}/agent.json` }],
    };
  }
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("顶层须为对象");
    json = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      issues: [{ field: "agent.json", message: `不是合法的 JSON:${(e as Error).message}` }],
    };
  }
  const name = typeof json.name === "string" ? json.name.trim() : "";
  if (!name) issues.push({ field: "agent.json.name", message: "name 必填" });
  for (const k of Object.keys(json)) {
    if (k !== "name" && k !== "description" && !(JSON_FIELDS as readonly string[]).includes(k)) {
      issues.push({ field: `agent.json.${k}`, message: `不认识的字段:${k}` });
    }
  }

  const prompt = (files[`${BUNDLE_DIR}/system-prompt.md`] ?? "").trim();
  if (!prompt) issues.push({ field: "system-prompt.md", message: "系统提示词不能为空" });

  // 技能:按 skills/<名称>/ 分组
  const bySkill = new Map<string, Record<string, string>>();
  const prefix = `${BUNDLE_DIR}/skills/`;
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const skill = rest.slice(0, slash);
    const group = bySkill.get(skill) ?? {};
    group[rest.slice(slash + 1)] = content;
    bySkill.set(skill, group);
  }
  const skillPackages: SkillPackage[] = [];
  for (const [skill, skillFiles] of bySkill) {
    const md = skillFiles["SKILL.md"];
    if (md === undefined) {
      issues.push({ field: `skills/${skill}`, message: "缺少 SKILL.md" });
      continue;
    }
    const { description, body } = splitFrontmatter(md);
    skillPackages.push({
      name: skill,
      description: description ?? "",
      files: { ...skillFiles, "SKILL.md": body },
    });
  }

  if (issues.length) return { ok: false, issues };

  const config: Record<string, unknown> = { systemPrompt: prompt };
  for (const k of JSON_FIELDS) if (json[k] !== undefined) config[k] = json[k];
  if (skillPackages.length) config.skillPackages = skillPackages;
  if (config.model === undefined) config.model = "sonnet";

  return {
    ok: true,
    agent: {
      name,
      description: typeof json.description === "string" ? json.description.trim() : undefined,
      config: config as unknown as AgentConfig,
    },
  };
}

function withFrontmatter(description: string, body: string): string {
  const desc = description.replace(/\r?\n/g, " ").trim();
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
  return `---\ndescription: ${JSON.stringify(desc)}\n---\n\n${stripped}`;
}

/** 读 SKILL.md 的 frontmatter 里的 description;只认 description,其它键忽略。 */
function splitFrontmatter(md: string): { description?: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: md };
  const line = m[1]?.split("\n").find((l) => l.startsWith("description:"));
  let description = line?.slice("description:".length).trim();
  if (description?.startsWith('"')) {
    try {
      description = JSON.parse(description) as string;
    } catch {
      // 不是合法的 JSON 字符串就按原文去掉引号
      description = description.replace(/^"|"$/g, "");
    }
  }
  return { description, body: md.slice(m[0].length).trimStart() };
}
