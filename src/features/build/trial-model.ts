// 试聊(gaps A5 / A6)的纯逻辑:一轮的回答、耗时,以及把这一轮预填成评测用例。

import { EMPTY_FORM, type EvalCaseForm } from "@/features/builder/eval-form";
import type { Turn } from "@/features/workbench/types";

/** 这一轮的正文与结构化结果 */
export function turnAnswer(turn: Turn): { text: string; structured?: unknown } {
  let text = "";
  let structured: unknown;
  for (const e of turn.events) {
    if (e.kind === "text" && !e.subagent) text += e.text;
    if (e.kind === "result" && e.structured !== undefined) structured = e.structured;
  }
  return { text: text.trim(), structured };
}

/** 耗时:开始到结束;两头缺一个就不显示 */
export function turnDurationText(turn: Turn, finishedAt: number | undefined): string | null {
  if (!turn.startedAt || finishedAt === undefined) return null;
  const ms = finishedAt - Date.parse(turn.startedAt);
  if (!(ms >= 0)) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

const isPrimitive = (v: unknown) =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * 预填用例表单:输入取这一轮的提问;期望从回答预填 ——
 * 有结构化结果就把顶层的简单字段写成「字段等于」,否则「正文须包含」取回答的第一句。
 * 只是预填,用户保存前可以改。
 */
export function caseFormFromTrial(t: {
  prompt: string;
  answer: string;
  structured?: unknown;
  hasInputSchema: boolean;
}): EvalCaseForm {
  const prompt = t.prompt.trim();
  let inputIsJson = false;
  if (t.hasInputSchema) {
    try {
      const v = JSON.parse(prompt) as unknown;
      inputIsJson = typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      inputIsJson = false;
    }
  }
  const name = inputIsJson
    ? "用例"
    : prompt
        .replace(/[？?。！!\s]+$/u, "")
        .replace(/\s+/g, " ")
        .slice(0, 20) || "用例";
  let fieldEquals = "";
  let contains = "";
  if (t.structured && typeof t.structured === "object" && !Array.isArray(t.structured)) {
    fieldEquals = Object.entries(t.structured as Record<string, unknown>)
      // 长文本(理由、摘要)每次都会变,不适合当断言
      .filter(([, v]) => isPrimitive(v) && !(typeof v === "string" && v.length > 24))
      .slice(0, 3)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("\n");
  } else if (t.answer.trim()) {
    contains =
      t.answer
        .trim()
        .split(/[。！？!?\n]/u)[0]
        ?.trim()
        .slice(0, 40) ?? "";
  }
  return { ...EMPTY_FORM, name, input: prompt, inputIsJson, fieldEquals, contains };
}
