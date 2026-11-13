import type { AgentEvent } from "@/lib/shared";
import type { FileNode, SessionSummary, Turn } from "./types";

export function sessionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("session")?.trim();
  return value || null;
}

/** ?agent=<id>:打开工作台时直接选中某个智能体(构建器"试运行"、设计会话"去试运行"用)。 */
export function agentIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("agent")?.trim();
  return value || null;
}

/**
 * ?q=:打开对话页时预填输入框(探索页、市场详情带着一句话过来)。只预填,不自动发送 ——
 * 用户要先看一眼、确认跑的是哪个智能体再发。
 */
export function promptFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("q")?.trim();
  return value || null;
}

export function withSessionInUrl(href: string, sessionId: string | null): string {
  try {
    const url = new URL(href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

export function filterSessionsForAgent(
  sessions: SessionSummary[],
  agentId: string,
  query: string,
): SessionSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (session.agentId !== agentId) return false;
    if (!normalizedQuery) return true;
    return `${session.title ?? ""} ${session.id}`.toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function updateTurnByLocalId(
  turns: Turn[],
  localId: string,
  update: (turn: Turn) => Turn,
): Turn[] {
  return turns.map((turn) => (turn.localId === localId ? update(turn) : turn));
}

// ─────────────────────────── 还原度修复:对话页的纯判断 ───────────────────────────

/** 智能体的提问通知:窄屏不弹(会挡住对话头);卡片就在眼前时也不弹,看不到卡片或页面在后台才提醒 */
export function shouldNotifyQuestion(at: {
  narrow: boolean;
  pageVisible: boolean;
  cardInView: boolean;
}): boolean {
  if (at.narrow) return false;
  return !at.pageVisible || !at.cardInView;
}

/** 停止确认框的说明 */
export function stopConfirmBody(queued: number): string {
  const base = "智能体会在当前步骤结束后停下，已生成的文件保留在工作区。";
  return queued > 0 ? `${base}排队中的 ${queued} 条消息不会发送。` : base;
}

/**
 * 运行中提交一条消息怎么处理:
 * 等你回答提问时拦下(先回答或选择不回答);等你确认工具调用时排队,本轮结束后发送;
 * 其余直接追加给运行中的智能体。
 */
export function submitGate(waits: {
  approvals: number;
  questions: number;
}): "block" | "queue" | "steer" {
  if (waits.questions > 0) return "block";
  if (waits.approvals > 0) return "queue";
  return "steer";
}

/** 失败卡片里的摘要:用 message,不带 `Error:` 之类的类名前缀 */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

interface VarDef {
  name: string;
  required?: boolean;
  secret?: boolean;
}

/** 还没填的必填变量名(密钥已保存时值是 "***",算已填) */
export function missingRequired(defs: readonly VarDef[], values: Record<string, string>): string[] {
  return defs.filter((d) => d.required && !values[d.name]?.trim()).map((d) => d.name);
}

/**
 * 「填写变量」保存时要发的值。已保存的密钥不回显,输入框留空 = 不修改(不发送这一项);
 * 其余照填写的发送(普通变量清空 = 删除)。
 */
export function variableUpdates(
  defs: readonly VarDef[],
  saved: Record<string, string>,
  draft: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) {
    const value = draft[d.name] ?? "";
    if (d.secret && saved[d.name] && !value.trim()) continue;
    out[d.name] = value;
  }
  return out;
}

const PREVIEWABLE = /\.(md|markdown|html?)$/i;

/** 一层文件里最新改过的 Markdown 或 HTML(首次打开工作区时自动预览它) */
export function latestPreviewable(nodes: readonly FileNode[]): string | null {
  let best: FileNode | null = null;
  for (const n of nodes) {
    if (n.type !== "file" || !PREVIEWABLE.test(n.name)) continue;
    if (!best || (n.mtime ?? 0) > (best.mtime ?? 0)) best = n;
  }
  return best?.path ?? null;
}

/** 最近一轮开始之后改过的文件:列表里标「新」 */
export function isFreshFile(node: FileNode, since: number | undefined): boolean {
  return node.type === "file" && since !== undefined && (node.mtime ?? 0) >= since;
}

/** 分叉重跑的标记:从第几轮之后分叉 */
export function branchLabel(turns: readonly Turn[], branchedFrom: string): string {
  const index = turns.findIndex((t) => t.runId === branchedFrom);
  if (index < 0) return "从上文某轮分叉重跑";
  return index === 0 ? "从会话开头分叉重跑" : `从第 ${index} 轮之后分叉重跑`;
}

/**
 * 对话页把底部提示抬到输入区上方(chat N2):输入区上沿到视口底的距离再加 12px 间隔,
 * 至少保持全站默认的 28px。返回值写进 CSS 变量 --toast-offset-bottom。
 */
export function toastOffsetAbove(viewportHeight: number, composerTop: number): string {
  return `${Math.max(28, Math.round(viewportHeight - composerTop + 12))}px`;
}

/** 取消排队的提示(chat N4):写出取消的是哪条,过长截断 */
export function unqueuedText(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "已取消排队";
  return `已取消排队：${t.length > 20 ? `${t.slice(0, 20)}…` : t}`;
}

/** 重跑开始的提示(chat N4):重跑第 N 轮 = 回到第 N 轮之前的状态 */
export function rerunStartedText(turns: readonly Turn[], fromRunId: string): string {
  const index = turns.findIndex((t) => t.runId === fromRunId);
  if (index < 0) return "正在重跑这一轮";
  return index === 0 ? "已回到会话开头，正在重跑" : `已回到第 ${index + 1} 轮之前的状态，正在重跑`;
}

/** 离开运行中的会话(切会话、开新会话、离开对话页)时的提示(chat N4) */
export function leftRunningText(title: string): string {
  return `「${title}」还在后台运行`;
}

export type ToolTimes = Record<string, { start: number; end?: number }>;

/**
 * 按收到事件的时刻记下每次工具调用的起止(事件里没有时间戳,只对本页实时收到的调用有效)。
 * 没有变化时原样返回,便于 React 跳过重渲染。
 */
export function recordToolTime(
  times: ToolTimes | undefined,
  event: AgentEvent,
  now: number,
): ToolTimes | undefined {
  if (event.kind === "tool_use" && event.toolUseId && !times?.[event.toolUseId]) {
    return { ...times, [event.toolUseId]: { start: now } };
  }
  if (event.kind === "tool_result" && event.toolUseId) {
    const cur = times?.[event.toolUseId];
    if (cur && cur.end === undefined) return { ...times, [event.toolUseId]: { ...cur, end: now } };
  }
  return times;
}

/** 耗时:10 秒内带一位小数,一分钟内取整秒,再长写分秒 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

interface Rate {
  meter: string;
  units: string;
  microCredits: string;
}

/** 重跑预估:按这一轮的输入 / 输出 token 与当前单价算(微积分,向上取整);算不出返回 null */
export function rerunEstimateMicro(
  rates: readonly Rate[],
  usage: { input: number; output: number },
): bigint | null {
  if (usage.input <= 0 && usage.output <= 0) return null;
  const cost = (meter: string, qty: number) => {
    const r = rates.find((x) => x.meter === meter);
    if (!r) return null;
    const units = BigInt(r.units);
    return (BigInt(Math.round(qty)) * BigInt(r.microCredits) + units - 1n) / units;
  };
  const input = cost("input_token", usage.input);
  const output = cost("output_token", usage.output);
  if (input === null || output === null) return null;
  return input + output;
}

/** 已回答的提问:回答里与选项同名的部分标成选中,其余是自己填写的(回答按「、」连接) */
export function answeredOptions(
  options: readonly { label: string }[],
  answer: string | null,
): { picked: string[]; other: string } {
  if (!answer) return { picked: [], other: "" };
  const labels = new Set(options.map((o) => o.label));
  const parts = answer.split("、");
  return {
    picked: parts.filter((p) => labels.has(p)),
    other: parts.filter((p) => !labels.has(p)).join("、"),
  };
}
