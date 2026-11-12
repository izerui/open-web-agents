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
 * 有结构化结果就把顶层的简单字段写成「字段等于」;自由文本不预填断言。
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
  const contains = "";
  if (t.structured && typeof t.structured === "object" && !Array.isArray(t.structured)) {
    fieldEquals = Object.entries(t.structured as Record<string, unknown>)
      // 长文本(理由、摘要)每次都会变,不适合当断言
      .filter(([, v]) => isPrimitive(v) && !(typeof v === "string" && v.length > 24))
      .slice(0, 3)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("\n");
  }
  // 没有结构化结果时不预填「正文须包含」:整句回答下次重跑几乎一定对不上,让用户自己填关键词
  return { ...EMPTY_FORM, name, input: prompt, inputIsJson, fieldEquals, contains };
}

/** 存为用例表单上的说明 */
export function trialCaseNote(t: { structured?: unknown }): string {
  return t.structured && typeof t.structured === "object"
    ? "已按这次的提问和结构化结果预填，可以再改"
    : "已按这次的提问预填；回答是自由文本，请在「正文须包含」里填几个必须出现的关键词";
}

// 「来自试聊」标记:用例接口没有来源字段,在本机记下从试聊存进来的用例 id(换设备看不到标记,不影响评测)
const trialKey = (agentId: string) => `owa.trial-cases.${agentId}`;

export function trialCaseIds(agentId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const v = JSON.parse(window.localStorage.getItem(trialKey(agentId)) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function markTrialCase(agentId: string, caseId: string): void {
  if (typeof window === "undefined") return;
  try {
    const ids = [...trialCaseIds(agentId), caseId].slice(-500);
    window.localStorage.setItem(trialKey(agentId), JSON.stringify(ids));
  } catch {
    // 存不了就不显示标记
  }
}
