// 评测用例的规则断言与判分。纯逻辑。
//
// 只做确定、可复现、不额外花钱的规则:运行是否成功、正文包含 / 不包含、结构化结果的字段等于、
// 花费与耗时上限。结构化结果是否符合 outputSchema 不用另写 —— 不符合的运行本身就判失败。

export interface FieldEquals {
  /** 结构化结果里的路径,如 `verdict`、`issues[0].level` */
  path: string;
  value: unknown;
}

export interface EvalAssertions {
  /** 期望运行成功;默认 true。想测"应当拒绝 / 应当失败"的用例时设 false */
  expectSuccess?: boolean;
  /** 正文须包含的片段(大小写不敏感) */
  contains?: string[];
  /** 正文不得包含的片段(大小写不敏感) */
  notContains?: string[];
  fieldEquals?: FieldEquals[];
  maxCostUsd?: number;
  maxDurationMs?: number;
}

/** 判分用到的那部分运行结果(与对外的统一结果契约同名字段) */
export interface GradedRun {
  status: string;
  structured: unknown;
  text: string | null;
  error: { message: string } | null;
  cost: { usd?: number } | null;
  durationMs: number | null;
}

export interface Grade {
  passed: boolean;
  /** 没通过的断言,各一句人话 */
  failures: string[];
}

const MAX_ITEMS = 20;
const MAX_TEXT = 2_000;

export function validateAssertions(
  raw: unknown,
): { ok: true; value: EvalAssertions } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "assertions 须为对象" };
  const a = raw as Record<string, unknown>;
  const out: EvalAssertions = {};
  if (a.expectSuccess !== undefined) {
    if (typeof a.expectSuccess !== "boolean")
      return { ok: false, reason: "expectSuccess 须为布尔值" };
    out.expectSuccess = a.expectSuccess;
  }
  for (const key of ["contains", "notContains"] as const) {
    const v = a[key];
    if (v === undefined) continue;
    if (
      !Array.isArray(v) ||
      v.length > MAX_ITEMS ||
      !v.every((x) => typeof x === "string" && x.trim() !== "" && x.length <= MAX_TEXT)
    ) {
      return { ok: false, reason: `${key} 须为不超过 ${MAX_ITEMS} 个非空字符串的数组` };
    }
    out[key] = v.map((x: string) => x.trim());
  }
  if (a.fieldEquals !== undefined) {
    const v = a.fieldEquals;
    if (!Array.isArray(v) || v.length > MAX_ITEMS) {
      return { ok: false, reason: `fieldEquals 须为不超过 ${MAX_ITEMS} 项的数组` };
    }
    const items: FieldEquals[] = [];
    for (const [i, f] of v.entries()) {
      const path = (f as { path?: unknown })?.path;
      if (typeof path !== "string" || parsePath(path) === null) {
        return {
          ok: false,
          reason: `fieldEquals[${i}].path 不是合法路径(如 a.b 或 items[0].name)`,
        };
      }
      if (!("value" in (f as object))) return { ok: false, reason: `fieldEquals[${i}] 缺少 value` };
      items.push({ path, value: (f as { value: unknown }).value });
    }
    out.fieldEquals = items;
  }
  for (const key of ["maxCostUsd", "maxDurationMs"] as const) {
    const v = a[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { ok: false, reason: `${key} 须为正数` };
    }
    out[key] = v;
  }
  return { ok: true, value: out };
}

/** `a.b[0].c` → ["a","b",0,"c"];不合法返回 null */
export function parsePath(path: string): (string | number)[] | null {
  if (!path || path.length > 200) return null;
  const out: (string | number)[] = [];
  for (const seg of path.split(".")) {
    const m = seg.match(/^([A-Za-z0-9_$-]+)((\[\d+\])*)$/);
    if (!m) return null;
    out.push(m[1] as string);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

function getPath(obj: unknown, path: (string | number)[]): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return { found: false };
    const next = (cur as Record<string | number, unknown>)[k];
    if (next === undefined) return { found: false };
    cur = next;
  }
  return { found: true, value: cur };
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

/**
 * 判分时看到的输出 —— 与结论一起保存,失败时能看到模型到底回了什么,
 * 而不必去翻那次运行(运行记录可能已被清理,且这里展示的必须正是判分依据的那一份)。
 * 正文与结构化结果都有长度上限,超出截断并标明。
 */
export interface EvalOutput {
  status: string;
  text?: string;
  textTruncated?: boolean;
  structured?: unknown;
  /** 结构化结果过大时只留序列化后的开头 */
  structuredPreview?: string;
  error?: string;
}

export const OUTPUT_TEXT_MAX = 4_000;
export const OUTPUT_STRUCTURED_MAX = 8_000;

/** 按字符(而非 UTF-16 码元)截断,不把代理对切成半个 */
const headChars = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n
    ? { head: chars.slice(0, n).join(""), cut: true }
    : { head: s, cut: false };
};

export function snapshotOutput(
  r: Pick<GradedRun, "status" | "text" | "structured" | "error">,
): EvalOutput {
  const out: EvalOutput = { status: r.status };
  if (r.text) {
    const { head, cut } = headChars(r.text, OUTPUT_TEXT_MAX);
    out.text = head;
    if (cut) out.textTruncated = true;
  }
  if (r.structured !== undefined && r.structured !== null) {
    const json = JSON.stringify(r.structured);
    if (json.length <= OUTPUT_STRUCTURED_MAX) out.structured = r.structured;
    else out.structuredPreview = headChars(json, OUTPUT_STRUCTURED_MAX).head;
  }
  if (r.error?.message) out.error = headChars(r.error.message, OUTPUT_TEXT_MAX).head;
  return out;
}

export function gradeRun(a: EvalAssertions, r: GradedRun): Grade {
  const failures: string[] = [];
  const expectSuccess = a.expectSuccess ?? true;
  if (expectSuccess && r.status !== "success") {
    failures.push(`期望运行成功,实际 ${r.status}${r.error?.message ? `:${r.error.message}` : ""}`);
  }
  if (!expectSuccess && r.status === "success") failures.push("期望运行失败,实际成功");

  const text = (r.text ?? "").toLowerCase();
  for (const s of a.contains ?? []) {
    if (!text.includes(s.toLowerCase())) failures.push(`正文不含「${s}」`);
  }
  for (const s of a.notContains ?? []) {
    if (text.includes(s.toLowerCase())) failures.push(`正文含有不该出现的「${s}」`);
  }
  for (const f of a.fieldEquals ?? []) {
    const path = parsePath(f.path);
    const got = path ? getPath(r.structured, path) : { found: false };
    if (!got.found) failures.push(`结构化结果里没有 ${f.path}`);
    else if (stable(got.value) !== stable(f.value)) {
      failures.push(`${f.path} 期望 ${show(f.value)},实际 ${show(got.value)}`);
    }
  }
  if (a.maxCostUsd !== undefined) {
    const usd = r.cost?.usd;
    if (usd === undefined) failures.push("花费未知,无法判断是否超过上限");
    else if (usd > a.maxCostUsd) failures.push(`花费 $${usd.toFixed(4)} 超过上限 $${a.maxCostUsd}`);
  }
  if (a.maxDurationMs !== undefined) {
    if (r.durationMs === null) failures.push("耗时未知,无法判断是否超过上限");
    else if (r.durationMs > a.maxDurationMs) {
      failures.push(`耗时 ${r.durationMs}ms 超过上限 ${a.maxDurationMs}ms`);
    }
  }
  return { passed: failures.length === 0, failures };
}
