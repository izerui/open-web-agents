// 评测用例表单 ↔ 接口请求体。纯逻辑,便于单测。

export interface EvalAssertionsBody {
  expectSuccess?: boolean;
  contains?: string[];
  notContains?: string[];
  fieldEquals?: { path: string; value: unknown }[];
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export interface EvalCaseForm {
  name: string;
  input: string;
  /** 输入按 JSON 对象解析(智能体声明了 inputSchema 时用) */
  inputIsJson: boolean;
  expectSuccess: boolean;
  /** 每行一个 */
  contains: string;
  notContains: string;
  /** 每行 `路径 = JSON 值`,如 `verdict = "pass"`、`score = 88` */
  fieldEquals: string;
  maxCostUsd: string;
  /** 秒 */
  maxDurationSec: string;
}

export const EMPTY_FORM: EvalCaseForm = {
  name: "",
  input: "",
  inputIsJson: false,
  expectSuccess: true,
  contains: "",
  notContains: "",
  fieldEquals: "",
  maxCostUsd: "",
  maxDurationSec: "",
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function buildCaseBody(
  f: EvalCaseForm,
):
  | { ok: true; body: { name: string; input: unknown; assertions: EvalAssertionsBody } }
  | { ok: false; error: string } {
  if (!f.name.trim()) return { ok: false, error: "请填用例名" };
  if (!f.input.trim()) return { ok: false, error: "请填输入" };
  let input: unknown = f.input.trim();
  if (f.inputIsJson) {
    try {
      input = JSON.parse(f.input);
    } catch {
      return { ok: false, error: "输入不是合法的 JSON" };
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "结构化输入须为 JSON 对象" };
    }
  }

  const a: EvalAssertionsBody = {};
  if (!f.expectSuccess) a.expectSuccess = false;
  const contains = lines(f.contains);
  if (contains.length) a.contains = contains;
  const notContains = lines(f.notContains);
  if (notContains.length) a.notContains = notContains;

  const eqs: { path: string; value: unknown }[] = [];
  for (const [i, l] of lines(f.fieldEquals).entries()) {
    const at = l.indexOf("=");
    if (at <= 0) return { ok: false, error: `字段等于第 ${i + 1} 行应为「路径 = 值」` };
    const path = l.slice(0, at).trim();
    const raw = l.slice(at + 1).trim();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // 不是 JSON 就当文本:写 `verdict = pass` 也行
      value = raw;
    }
    eqs.push({ path, value });
  }
  if (eqs.length) a.fieldEquals = eqs;

  if (f.maxCostUsd.trim()) {
    const v = Number(f.maxCostUsd);
    if (!(v > 0)) return { ok: false, error: "花费上限须为正数" };
    a.maxCostUsd = v;
  }
  if (f.maxDurationSec.trim()) {
    const v = Number(f.maxDurationSec);
    if (!(v > 0)) return { ok: false, error: "耗时上限须为正数" };
    a.maxDurationMs = Math.round(v * 1000);
  }
  return { ok: true, body: { name: f.name.trim(), input, assertions: a } };
}

export function formFromCase(c: {
  name: string;
  input: unknown;
  assertions: EvalAssertionsBody;
}): EvalCaseForm {
  const a = c.assertions ?? {};
  const isJson = typeof c.input !== "string";
  return {
    name: c.name,
    input: isJson ? JSON.stringify(c.input, null, 2) : String(c.input),
    inputIsJson: isJson,
    expectSuccess: a.expectSuccess !== false,
    contains: (a.contains ?? []).join("\n"),
    notContains: (a.notContains ?? []).join("\n"),
    fieldEquals: (a.fieldEquals ?? [])
      .map((f) => `${f.path} = ${JSON.stringify(f.value)}`)
      .join("\n"),
    maxCostUsd: a.maxCostUsd !== undefined ? String(a.maxCostUsd) : "",
    maxDurationSec: a.maxDurationMs !== undefined ? String(a.maxDurationMs / 1000) : "",
  };
}

/** 列表里一行看得懂的断言摘要 */
export function summarizeAssertions(a: EvalAssertionsBody): string {
  const parts: string[] = [a.expectSuccess === false ? "期望失败" : "期望成功"];
  if (a.contains?.length) parts.push(`含 ${a.contains.map((s) => `「${s}」`).join("")}`);
  if (a.notContains?.length) parts.push(`不含 ${a.notContains.map((s) => `「${s}」`).join("")}`);
  for (const f of a.fieldEquals ?? []) parts.push(`${f.path} = ${JSON.stringify(f.value)}`);
  if (a.maxCostUsd !== undefined) parts.push(`≤ $${a.maxCostUsd}`);
  if (a.maxDurationMs !== undefined) parts.push(`≤ ${a.maxDurationMs / 1000}s`);
  return parts.join(" · ");
}
