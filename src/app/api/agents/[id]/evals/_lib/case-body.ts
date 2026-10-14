import { type EvalAssertions, validateAssertions } from "@/lib/modules/eval/domain/assertions";
import { MAX_PROMPT_CHARS } from "@/lib/modules/run/domain/limits";

/** 用例请求体:{ name, input, assertions }。input 是文本或对象(按 inputSchema 的结构化输入)。 */
export function parseCaseBody(
  raw: unknown,
):
  | { ok: true; value: { name: string; input: unknown; assertions: EvalAssertions } }
  | { ok: false; reason: string } {
  const b = (raw ?? {}) as { name?: unknown; input?: unknown; assertions?: unknown };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 255) return { ok: false, reason: "name 须为 1~255 字符" };
  const input = b.input;
  const isText = typeof input === "string" && input.trim() !== "";
  const isObject = typeof input === "object" && input !== null && !Array.isArray(input);
  if (!isText && !isObject) return { ok: false, reason: "input 须为非空文本或对象" };
  if (JSON.stringify(input).length > MAX_PROMPT_CHARS) {
    return { ok: false, reason: `input 不能超过 ${MAX_PROMPT_CHARS} 字符` };
  }
  const a = validateAssertions(b.assertions);
  if (!a.ok) return { ok: false, reason: a.reason };
  return {
    ok: true,
    value: { name, input: isText ? (input as string).trim() : input, assertions: a.value },
  };
}
