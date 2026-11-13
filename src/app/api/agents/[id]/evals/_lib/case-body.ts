import { type EvalAssertions, validateAssertions } from "@/lib/modules/eval/domain/assertions";
import { EVAL_CASE_SOURCES, type EvalCaseSource } from "@/lib/modules/eval/ports";
import { MAX_PROMPT_CHARS } from "@/lib/modules/run/domain/limits";

/**
 * 用例请求体:{ name, input, assertions, source? }。input 是文本或对象(按 inputSchema 的结构化输入);
 * source 只在新建时生效(manual | trial,不给为 manual),修改用例时忽略。
 */
export function parseCaseBody(raw: unknown):
  | {
      ok: true;
      value: { name: string; input: unknown; assertions: EvalAssertions; source: EvalCaseSource };
    }
  | { ok: false; reason: string } {
  const b = (raw ?? {}) as {
    name?: unknown;
    input?: unknown;
    assertions?: unknown;
    source?: unknown;
  };
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
  if (b.source !== undefined && !EVAL_CASE_SOURCES.includes(b.source as EvalCaseSource)) {
    return { ok: false, reason: "source 须为 manual 或 trial" };
  }
  return {
    ok: true,
    value: {
      name,
      input: isText ? (input as string).trim() : input,
      assertions: a.value,
      source: (b.source as EvalCaseSource | undefined) ?? "manual",
    },
  };
}
