// 智能体配置的校验。纯逻辑,构建器与 API 共用同一套规则。
//
// 为什么要单独校验:MCP/skills 配错了不会在保存时报错,而是在【运行时】让 agent
// 起不来或静默少能力 —— 那时候排查成本高得多。宁可在构建器里当场拦住。

import {
  PERMISSION_MODES,
  isModelAlias,
  protectedEscapeHatchKeys,
  validateSkillPackages,
} from "@/lib/shared";
import type { AgentConfig } from "./config";
import { checkUrlTemplate } from "./config";

export interface ConfigIssue {
  field: string;
  message: string;
}

/** 模型引用解析出的信息。group 是模型所属来源的不透明标识,同一次运行只能用同一来源的模型。 */
export interface ModelRefInfo {
  name: string;
  kind: string;
  /** 模型与其来源都处于启用状态 */
  enabled: boolean;
  group: string;
}

/** 平台模型目录的只读视图(别名按当前映射解析)。 */
export interface ModelCatalogView {
  resolve(ref: string): ModelRefInfo | null;
}

export interface ConfigValidationPolicy {
  /** stdio MCP 会在宿主机启动进程,默认禁止。 */
  allowStdioMcp?: boolean;
  /** 给了就检查模型是否存在、可用、子代理与主模型同一来源;不给只检查格式。 */
  models?: ModelCatalogView;
}

/** 别名,或模型目录里的模型 id(与模型 id 的格式规则一致)。 */
const MODEL_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function checkModelRef(
  ref: string,
  field: string,
  label: string,
  models: ModelCatalogView | undefined,
  issues: ConfigIssue[],
): ModelRefInfo | null {
  if (!isModelAlias(ref) && !MODEL_REF.test(ref)) {
    issues.push({ field, message: `${label}须从平台模型中选择` });
    return null;
  }
  if (!models) return null;
  const info = models.resolve(ref);
  if (!info) {
    issues.push({ field, message: `${label}不存在,请重新选择` });
    return null;
  }
  if (info.kind !== "llm") {
    issues.push({ field, message: `${label}只能选择文本模型` });
    return null;
  }
  if (!info.enabled) {
    issues.push({ field, message: `${label}「${info.name}」已停用,请选择其他模型` });
    return null;
  }
  return info;
}

const EFFORTS = new Set(["low", "medium", "high"]);

/** MCP 名称会作为 SDK mcpServers 的 key,必须是安全标识符。 */
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 返回所有问题(而非遇到第一个就停)—— 一次性把配置问题都告诉用户。 */
export function validateAgentConfig(
  cfg: Partial<AgentConfig>,
  policy: ConfigValidationPolicy = {},
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!cfg.systemPrompt?.trim()) {
    issues.push({ field: "systemPrompt", message: "系统提示词不能为空" });
  }

  const mainModel =
    cfg.model !== undefined
      ? checkModelRef(String(cfg.model), "model", "模型", policy.models, issues)
      : null;

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
        const err = checkUrlTemplate(m.url);
        if (err) issues.push({ field: `${at}.url`, message: err });
      }
    } else if (m.type === "stdio") {
      if (!policy.allowStdioMcp) {
        issues.push({
          field: `${at}.type`,
          message: "平台未启用 stdio MCP（需部署方设置 OWA_ALLOW_STDIO_MCP=1）",
        });
        continue;
      }
      if (!m.command?.trim()) {
        issues.push({ field: `${at}.command`, message: "stdio 类型必须给 command" });
      }
      if (
        m.args !== undefined &&
        (!Array.isArray(m.args) || m.args.some((x) => typeof x !== "string"))
      ) {
        issues.push({ field: `${at}.args`, message: "args 必须是字符串数组" });
      }
      if (
        m.env !== undefined &&
        (typeof m.env !== "object" ||
          m.env === null ||
          Array.isArray(m.env) ||
          Object.values(m.env).some((x) => typeof x !== "string"))
      ) {
        issues.push({ field: `${at}.env`, message: "env 必须是字符串键值对象" });
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

  issues.push(...validateSkillPackages(cfg.skillPackages));

  const seenSub = new Set<string>();
  for (const [i, sa] of (cfg.subagents ?? []).entries()) {
    const at = `subagents[${i}]`;
    if (!sa.name?.trim()) issues.push({ field: `${at}.name`, message: "子代理名不能为空" });
    else if (seenSub.has(sa.name)) {
      issues.push({ field: `${at}.name`, message: `子代理重名:${sa.name}` });
    } else seenSub.add(sa.name);

    if (!sa.prompt?.trim()) issues.push({ field: `${at}.prompt`, message: "子代理提示词不能为空" });
    if (sa.model !== undefined) {
      const sub = checkModelRef(
        String(sa.model),
        `${at}.model`,
        "子代理模型",
        policy.models,
        issues,
      );
      // 一次运行只有一套凭证:子代理只能用与主模型同一来源的模型
      if (sub && mainModel && sub.group !== mainModel.group) {
        issues.push({
          field: `${at}.model`,
          message: `子代理「${sa.name}」的模型不能与主模型同时使用,请重新选择`,
        });
      }
    }
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

  // 权限模式必须是 SDK 认识的值。写错了(比如 "bypass")SDK 那边不一定报错,
  // 而是悄悄回落到默认行为 —— 用户以为配了免审批,实际每次都在等审批。
  if (cfg.permissionMode !== undefined && !PERMISSION_MODES.includes(cfg.permissionMode)) {
    issues.push({
      field: "permissionMode",
      message: `未知的权限模式,可选:${PERMISSION_MODES.join(" / ")}`,
    });
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

  if (
    cfg.unattendedApproval !== undefined &&
    cfg.unattendedApproval !== "allow" &&
    cfg.unattendedApproval !== "deny"
  ) {
    issues.push({ field: "unattendedApproval", message: "须为 allow 或 deny" });
  }

  if (cfg.starters !== undefined) {
    if (
      !Array.isArray(cfg.starters) ||
      cfg.starters.length > 4 ||
      cfg.starters.some((x) => typeof x !== "string" || !x.trim() || x.length > 200)
    ) {
      issues.push({ field: "starters", message: "最多 4 条,每条 1~200 字" });
    }
  }

  // 逃生舱碰不了安全边界 —— 运行时会忽略这些字段,这里直接说清楚,免得作者以为生效了
  const blocked = protectedEscapeHatchKeys(cfg.escapeHatch);
  if (blocked.length > 0) {
    issues.push({
      field: "escapeHatch",
      message: `以下字段属于安全边界,不能通过逃生舱覆盖:${blocked.join(", ")}`,
    });
  }

  if (cfg.variables !== undefined) {
    if (!Array.isArray(cfg.variables)) {
      issues.push({ field: "variables", message: "变量定义须为数组" });
    } else {
      const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
      const seen = new Set<string>();
      for (const [i, v] of cfg.variables.entries()) {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          issues.push({ field: `variables[${i}]`, message: "变量定义须为对象" });
          continue;
        }
        if (typeof v.name !== "string" || !VAR_NAME.test(v.name)) {
          issues.push({
            field: `variables[${i}].name`,
            message: "变量名须为字母/下划线开头的 1~64 位标识符",
          });
        } else if (seen.has(v.name)) {
          issues.push({ field: `variables[${i}].name`, message: `变量名 ${v.name} 重复` });
        } else {
          seen.add(v.name);
        }
        if (
          v.description !== undefined &&
          (typeof v.description !== "string" || v.description.length > 512)
        ) {
          issues.push({
            field: `variables[${i}].description`,
            message: "变量说明须为最多 512 字的文本",
          });
        }
        if (typeof v.required !== "boolean") {
          issues.push({ field: `variables[${i}].required`, message: "required 须为布尔值" });
        }
        if (typeof v.secret !== "boolean") {
          issues.push({ field: `variables[${i}].secret`, message: "secret 须为布尔值" });
        }
      }
      if (cfg.variables.length > 50) {
        issues.push({ field: "variables", message: "单个智能体最多定义 50 个变量" });
      }
    }
  }

  return issues;
}
