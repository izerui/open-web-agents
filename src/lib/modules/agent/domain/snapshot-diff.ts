// 两个版本(或版本与草稿)之间改了什么。纯逻辑。
//
// 发布、回滚之前要看得到差异:提示词改了哪几行、加了哪个子代理、契约动了哪个字段。
// - 长文本(提示词、技能内容)给出行级差异
// - 带 name 的对象列表(子代理、MCP、技能包)按名字对齐 —— 只是换了顺序不算改动
// - 其它值按路径比较,原样给出前后值

import type { AgentSnapshot } from "@/lib/modules/agent/ports";

export type LineOp = { op: "same" | "add" | "del"; text: string };

export type SnapshotChange =
  | { path: string; kind: "added"; after: unknown }
  | { path: string; kind: "removed"; before: unknown }
  | {
      path: string;
      kind: "changed";
      before: unknown;
      after: unknown;
      /** 文本的行级差异;文本太长算不动时不给(lines 缺省) */
      lines?: LineOp[];
    };

/** 行级差异的规模上限(两边行数之积),超过就只给前后值 */
const MAX_LINE_CELLS = 4_000_000;

export function diffSnapshots(before: AgentSnapshot, after: AgentSnapshot): SnapshotChange[] {
  const out: SnapshotChange[] = [];
  walk("", before, after, out);
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNamedList(v: unknown): v is { name: string }[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => isObject(x) && typeof x.name === "string" && x.name !== "")
  );
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

const join = (base: string, key: string) => (base ? `${base}.${key}` : key);

function walk(path: string, a: unknown, b: unknown, out: SnapshotChange[]): void {
  if (a === undefined && b === undefined) return;
  if (a === undefined) {
    out.push({ path, kind: "added", after: b });
    return;
  }
  if (b === undefined) {
    out.push({ path, kind: "removed", before: a });
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) walk(join(path, k), a[k], b[k], out);
    return;
  }
  // 两边都是带 name 的列表(允许一边为空):按名字对齐
  const namedOrEmpty = (v: unknown) => isNamedList(v) || (Array.isArray(v) && v.length === 0);
  if (namedOrEmpty(a) && namedOrEmpty(b) && (isNamedList(a) || isNamedList(b))) {
    const byName = (xs: unknown) => new Map((xs as { name: string }[]).map((x) => [x.name, x]));
    const ma = byName(a);
    const mb = byName(b);
    for (const name of [...new Set([...ma.keys(), ...mb.keys()])]) {
      walk(`${path}[${name}]`, ma.get(name), mb.get(name), out);
    }
    return;
  }
  if (stable(a) === stable(b)) return;
  if (typeof a === "string" && typeof b === "string" && (a.includes("\n") || b.includes("\n"))) {
    const lines = lineDiff(a.split("\n"), b.split("\n"));
    out.push({ path, kind: "changed", before: a, after: b, ...(lines ? { lines } : {}) });
    return;
  }
  out.push({ path, kind: "changed", before: a, after: b });
}

/** 最长公共子序列的行级差异;规模超限返回 undefined */
export function lineDiff(a: string[], b: string[]): LineOp[] | undefined {
  // 去掉首尾相同的行再算,常见的"中间改了几行"规模会小得多
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_LINE_CELLS) return undefined;

  const n = midA.length;
  const m = midB.length;
  // dp[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const at = (i: number, j: number) => (dp[i] as Uint32Array)[j] as number;
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const mid: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ op: "same", text: midA[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      mid.push({ op: "del", text: midA[i] as string });
      i++;
    } else {
      mid.push({ op: "add", text: midB[j] as string });
      j++;
    }
  }
  while (i < n) mid.push({ op: "del", text: midA[i++] as string });
  while (j < m) mid.push({ op: "add", text: midB[j++] as string });

  const same = (xs: string[]) => xs.map((text) => ({ op: "same" as const, text }));
  return [...same(a.slice(0, start)), ...mid, ...same(a.slice(endA))];
}
