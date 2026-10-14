// 入口输入的上限。纯规则,入口路由与入队服务共用同一份。

/**
 * 单轮输入的最大字符数。
 *
 * 【为什么要在入口拦】runs.prompt 曾经是 varchar(8192) 且没有任何入口校验:
 * 结构化 input 稍大一点,INSERT 在 MySQL 严格模式下直接报错 500 —— 而 invoke
 * 此时已经建好了会话和工作目录,留下一堆空壳。现在列是 MEDIUMTEXT,
 * 这个上限是产品约束(防止把整本书塞进一轮),不是存储约束。
 */
export const MAX_PROMPT_CHARS = 200_000;

export function checkPromptSize(prompt: string): { ok: true } | { ok: false; reason: string } {
  if (prompt.length <= MAX_PROMPT_CHARS) return { ok: true };
  return {
    ok: false,
    reason: `输入过长:${prompt.length} 字符,上限 ${MAX_PROMPT_CHARS}`,
  };
}

/** 调用方给的幂等键:可见 ASCII,1~128 字符。 */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY.test(key);
}
