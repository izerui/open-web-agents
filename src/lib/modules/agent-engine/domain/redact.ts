// 脱敏纯域逻辑。防 API key / OSS secret 经事件流泄露到前端与日志。零外部依赖。

/**
 * 掩码文本里的密钥值:
 * ① `*_KEY=值 / *_SECRET=值 / *_TOKEN=值 / password=值` → 保留变量名、值打码(便于排查是哪个变量);
 * ② 裸露的 `sk-` 前缀密钥串 → 兜底打码(即便没有 `名=` 前缀)。
 *
 * agent 常在 Bash 里 `SOME_API_KEY=sk-xxx python3 …` 内联注入密钥,command 会原样进事件流。
 */
export function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(
      /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)=(["']?)[^\s"']+\2/gi,
      (_m, name, q) => `${name}=${q}***${q}`,
    )
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-***");
}

/** 递归掩码工具入参里的字符串值(Bash 的 command、其它工具的字符串参数都可能含密钥)。 */
export function redactInput(input: unknown): unknown {
  if (typeof input === "string") return redactSecrets(input);
  if (Array.isArray(input)) return input.map(redactInput);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = redactInput(v);
    return out;
  }
  return input;
}
