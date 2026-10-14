// 逃生舱(agent 配置的 escapeHatch)的安全边界。引擎与配置校验共用这一份。

/**
 * 逃生舱改不了的字段:隔离、围栏、凭证、进程与会话控制。
 * 权限模式有正式的配置字段(permissionMode),不走逃生舱。
 */
export const ESCAPE_HATCH_PROTECTED = [
  "cwd",
  "env",
  "hooks",
  "sandbox",
  "settingSources",
  "settings",
  "canUseTool",
  "permissionMode",
  "allowDangerouslySkipPermissions",
  "allowedTools",
  "disallowedTools",
  "tools",
  "mcpServers",
  "plugins",
  "additionalDirectories",
  "abortController",
  "resume",
  "forkSession",
  "continue",
  "includePartialMessages",
  "outputFormat",
  "pathToClaudeCodeExecutable",
  "executable",
  "executableArgs",
  "extraArgs",
  "spawnClaudeCodeProcess",
  "stderr",
] as const;

export function protectedEscapeHatchKeys(hatch: Record<string, unknown> | undefined): string[] {
  if (!hatch) return [];
  return Object.keys(hatch).filter((k) =>
    (ESCAPE_HATCH_PROTECTED as readonly string[]).includes(k),
  );
}
