// MCP 测试连接的规则:按运行时同样的方式把变量换进配置,找出还没有值的变量,单独校验这一个 MCP,
// 以及把结果里可能带出的密钥抹掉。纯逻辑,零 IO。

import type { McpDef } from "@/lib/shared";
import { splitVariables, substituteMcpServer } from "./build-spec";
import type { VariableDef } from "./config";
import { validateAgentConfig } from "./validate-config";

/** 失败的原因,界面按它给出说明 */
export type McpCheckFailure =
  | "invalid_config"
  | "missing_variables"
  | "stdio_disabled"
  | "forbidden_address"
  | "unreachable"
  | "timeout"
  | "auth"
  | "oauth"
  | "not_mcp"
  | "process_failed";

export interface McpCheckTool {
  name: string;
  description?: string;
}

export type McpCheckResult =
  | {
      ok: true;
      transport: "streamable_http" | "sse" | "stdio";
      server: { name?: string; version?: string };
      tools: McpCheckTool[];
      latencyMs: number;
    }
  | {
      ok: false;
      kind: McpCheckFailure;
      message: string;
      /** missing_variables 时:还没有值的变量名 */
      missing?: string[];
    };

const VAR_REF = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** 配置里引用到的变量名(url 与 env) */
function referencedVariables(def: McpDef): string[] {
  const texts = [def.url ?? "", ...Object.values(def.env ?? {})];
  return [...new Set(texts.flatMap((t) => [...t.matchAll(VAR_REF)].map((m) => m[1] as string)))];
}

/**
 * 按运行时的方式准备要测试的配置:只替换智能体声明过的变量(普通与密钥都进 MCP),
 * 值为本人在这个智能体上保存的。替换后仍留着 {{变量}} 的,列出缺哪些 —— 运行时同样连不上。
 * 同时返回所有用到的变量值,用于从错误信息里抹掉密钥。
 */
export function prepareMcpForCheck(
  def: McpDef,
  defs: VariableDef[] | undefined,
  saved: Record<string, string>,
): { def: McpDef; secrets: string[] } | { missing: string[] } {
  const { plain, secrets } = splitVariables(defs, saved);
  const values = { ...plain, ...secrets };
  const resolved = substituteMcpServer(def, values);
  const missing = referencedVariables(resolved);
  if (missing.length > 0) return { missing };
  const used = referencedVariables(def)
    .map((n) => values[n])
    .filter((v): v is string => typeof v === "string" && v.length >= 4);
  return { def: resolved, secrets: used };
}

/** 单独校验这一个 MCP(名称、类型、url、command 等),返回第一条问题;stdio 未启用单独标出 */
export function checkMcpConfig(
  def: McpDef,
  allowStdioMcp: boolean,
): { kind: "invalid_config" | "stdio_disabled"; message: string } | null {
  if (def.type === "stdio" && !allowStdioMcp) {
    return {
      kind: "stdio_disabled",
      message: "平台未启用 stdio MCP(需部署方设置 OWA_ALLOW_STDIO_MCP=1),运行时也无法使用",
    };
  }
  const issue = validateAgentConfig(
    { systemPrompt: "-", mcpServers: [def] },
    { allowStdioMcp },
  ).find((i) => i.field.startsWith("mcpServers[0]"));
  return issue ? { kind: "invalid_config", message: issue.message } : null;
}

/**
 * 把文本里的密钥抹掉:用到的变量值、地址里的查询串与账号密码。
 * 对方服务器的报错、连接错误都可能原样带出完整地址
 */
export function redactSecrets(text: string, secrets: string[], url?: string): string {
  let out = text;
  const parts: string[] = [...secrets];
  if (url) {
    parts.push(url);
    try {
      const u = new URL(url);
      if (u.search) parts.push(u.search.slice(1));
      if (u.password) parts.push(u.password);
      if (u.username) parts.push(u.username);
    } catch {
      // 不是合法地址:只按原文抹
    }
  }
  for (const p of parts.sort((a, b) => b.length - a.length)) {
    if (p.length >= 4) out = out.split(p).join("***");
  }
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}
