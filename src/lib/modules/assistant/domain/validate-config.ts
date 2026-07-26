// 助手配置的校验。纯逻辑,构建器与 API 共用同一套规则。
//
// 为什么要单独校验:MCP/skills 配错了不会在保存时报错,而是在【运行时】让 agent
// 起不来或静默少能力 —— 那时候排查成本高得多。宁可在构建器里当场拦住。

import type { AssistantConfig } from "./config";

export interface ConfigIssue {
  field: string;
  message: string;
}

const MODEL_ALIASES = new Set(["fable", "opus", "sonnet", "haiku"]);
const EFFORTS = new Set(["low", "medium", "high"]);

/** MCP 名称会作为 SDK mcpServers 的 key,必须是安全标识符。 */
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function checkUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "URL 格式不正确";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "只支持 http/https";
  }
  return null;
}

/** 返回所有问题(而非遇到第一个就停)—— 一次性把配置问题都告诉用户。 */
export function validateAssistantConfig(cfg: Partial<AssistantConfig>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!cfg.systemPrompt?.trim()) {
    issues.push({ field: "systemPrompt", message: "系统提示词不能为空" });
  }

  if (cfg.model !== undefined && !MODEL_ALIASES.has(cfg.model)) {
    issues.push({ field: "model", message: `模型别名须是 ${[...MODEL_ALIASES].join("/")}` });
  }

  if (cfg.effort !== undefined && !EFFORTS.has(cfg.effort)) {
    issues.push({ field: "effort", message: `effort 须是 ${[...EFFORTS].join("/")}` });
  }

  if (cfg.maxTurns !== undefined) {
    if (!Number.isInteger(cfg.maxTurns) || cfg.maxTurns < 1 || cfg.maxTurns > 500) {
      issues.push({ field: "maxTurns", message: "最大轮次须是 1–500 的整数" });
    }
  }

  const seenMcp = new Set<string>();
  for (const [i, m] of (cfg.mcpServers ?? []).entries()) {
    const at = `mcpServers[${i}]`;
    if (!MCP_NAME.test(m.name ?? "")) {
      issues.push({ field: `${at}.name`, message: "名称只能含字母/数字/下划线/连字符" });
    } else if (seenMcp.has(m.name)) {
      // 重名会在组装 SDK options 时互相覆盖,静默丢掉一个
      issues.push({ field: `${at}.name`, message: `名称重复:${m.name}` });
    } else {
      seenMcp.add(m.name);
    }

    if (m.type !== "http" && m.type !== "stdio") {
      issues.push({ field: `${at}.type`, message: "类型须是 http 或 stdio" });
    }
    if (m.type === "http") {
      if (!m.url) issues.push({ field: `${at}.url`, message: "http 类型必须给 url" });
      else {
        const err = checkUrl(m.url);
        if (err) issues.push({ field: `${at}.url`, message: err });
      }
    }
  }

  const seenSkill = new Set<string>();
  for (const [i, s] of (cfg.skills ?? []).entries()) {
    if (!s.trim()) {
      issues.push({ field: `skills[${i}]`, message: "技能名不能为空" });
    } else if (seenSkill.has(s)) {
      issues.push({ field: `skills[${i}]`, message: `技能重复:${s}` });
    } else {
      seenSkill.add(s);
    }
  }

  const seenSub = new Set<string>();
  for (const [i, sa] of (cfg.subagents ?? []).entries()) {
    const at = `subagents[${i}]`;
    if (!sa.name?.trim()) issues.push({ field: `${at}.name`, message: "子代理名不能为空" });
    else if (seenSub.has(sa.name)) {
      issues.push({ field: `${at}.name`, message: `子代理重名:${sa.name}` });
    } else seenSub.add(sa.name);

    if (!sa.prompt?.trim()) issues.push({ field: `${at}.prompt`, message: "子代理提示词不能为空" });
  }

  const ar = cfg.approvalRules;
  if (ar) {
    for (const [i, t] of (ar.tools ?? []).entries()) {
      if (!t?.trim())
        issues.push({ field: `approvalRules.tools[${i}]`, message: "工具名不能为空" });
    }
    for (const [i, p] of (ar.commandPatterns ?? []).entries()) {
      // 空模式会命中一切命令,等于把 all 打开却看不出来
      if (!p?.trim()) {
        issues.push({
          field: `approvalRules.commandPatterns[${i}]`,
          message: "模式不能为空(空串会命中所有命令)",
        });
      }
    }
  }

  if (cfg.outputSchema !== undefined) {
    const s = cfg.outputSchema as { type?: unknown };
    // 结构化输出的顶层必须是 object —— 调用方按字段取值,顶层数组/标量没法当接口契约
    if (s.type !== undefined && s.type !== "object") {
      issues.push({ field: "outputSchema.type", message: "顶层类型须是 object" });
    }
  }

  if (cfg.inputSchema !== undefined) {
    const s = cfg.inputSchema as { type?: unknown };
    // 入参同理:调用方按字段传值,顶层是标量的话校验就退化得没有意义
    if (s.type !== undefined && s.type !== "object") {
      issues.push({ field: "inputSchema.type", message: "顶层类型须是 object" });
    }
  }

  return issues;
}
