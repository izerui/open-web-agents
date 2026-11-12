// 探索首页「你的 AI 同事正在工作」(gaps.md A2):最近会话的状态与交付物。
//
// 现有产品没有「交付物」概念。这里的做法:最近一次运行成功、且工作区里有它开始之后
// 写出的文件,就算「成果已交付」,文件卡显示最新的那个;没有文件就是「已回复」。

import type { FileNode } from "@/lib/modules/artifacts/ports";
import type { AgentEvent, RunState } from "@/lib/shared";

export type WorkStatus = "running" | "delivered" | "replied" | "failed" | "cancelled" | "idle";

export function workStatus(
  lastRun: RunState | undefined,
  file: { name: string } | null,
): WorkStatus {
  switch (lastRun) {
    case "pending":
    case "running":
      return "running";
    case "success":
      return file ? "delivered" : "replied";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

export interface DeliveredFile {
  name: string;
  path: string;
  size?: number;
  mtime?: number;
}

/** 工作区根目录下最近修改的文件;隐藏文件(SDK 的 .claude 等)与目录不算。 */
export function latestFile(
  nodes: readonly FileNode[],
  opts: { since?: number } = {},
): DeliveredFile | null {
  let best: FileNode | null = null;
  for (const n of nodes) {
    if (n.type !== "file" || n.name.startsWith(".")) continue;
    if (opts.since !== undefined && (n.mtime ?? 0) < opts.since) continue;
    if (!best || (n.mtime ?? 0) > (best.mtime ?? 0)) best = n;
  }
  return best ? { name: best.name, path: best.path, size: best.size, mtime: best.mtime } : null;
}

// ---- 正在工作卡片的步骤进度 ----

export type StepState = "done" | "running" | "error" | "pending";

export interface WorkStep {
  label: string;
  state: StepState;
}

const MAX_LABEL = 60;

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
}

function field(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 一次工具调用的中文说法(卡片上一行);认不出的工具写「调用 X」。 */
export function stepLabel(tool: string, input: unknown): string {
  const file = field(input, "file_path") ?? field(input, "path") ?? field(input, "notebook_path");
  switch (tool) {
    case "Read":
      return clip(file ? `读取 ${baseName(file)}` : "读取文件");
    case "Write":
      return clip(file ? `写入 ${baseName(file)}` : "写入文件");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(file ? `修改 ${baseName(file)}` : "修改文件");
    case "Bash": {
      const desc = field(input, "description");
      if (desc) return clip(desc);
      const cmd = field(input, "command");
      return clip(cmd ? `运行命令 ${cmd}` : "运行命令");
    }
    case "Grep": {
      const pattern = field(input, "pattern");
      return clip(pattern ? `搜索「${pattern}」` : "搜索文件内容");
    }
    case "Glob": {
      const pattern = field(input, "pattern");
      return clip(pattern ? `查找文件 ${pattern}` : "查找文件");
    }
    case "WebSearch": {
      const q = field(input, "query");
      return clip(q ? `搜索网页「${q}」` : "搜索网页");
    }
    case "WebFetch": {
      const url = field(input, "url");
      let host = url;
      try {
        if (url) host = new URL(url).hostname;
      } catch {
        // 不是合法地址就原样显示
      }
      return clip(host ? `打开网页 ${host}` : "打开网页");
    }
    case "Task":
    case "Agent": {
      const desc = field(input, "description");
      return clip(desc ? `交给子智能体：${desc}` : "交给子智能体");
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return clip(`调用 ${mcp[1]}.${mcp[2]}`);
  return clip(`调用 ${tool}`);
}

/** 不算「一步」的工具:提问是等用户,计划单独处理 */
const NOT_A_STEP = new Set(["AskUserQuestion", "TodoWrite", "ExitPlanMode"]);

interface Todo {
  content: string;
  status: string;
  activeForm?: string;
}

function todosOf(input: unknown): Todo[] | null {
  const list = input && typeof input === "object" ? (input as { todos?: unknown }).todos : null;
  if (!Array.isArray(list)) return null;
  const todos = list.filter(
    (t): t is Todo =>
      Boolean(t) &&
      typeof (t as Todo).content === "string" &&
      typeof (t as Todo).status === "string",
  );
  return todos.length ? todos : null;
}

/**
 * 正在工作的会话最近的步骤(原型:已完成的打勾,当前步骤转圈)。
 * - 有计划(TodoWrite)时按最新那份计划:当前步骤和它前后,共 limit 条
 * - 没有计划时取最近 limit 条主智能体的工具调用;有结果的算完成(出错的标出来),
 *   最后一条还没结果的是当前步骤
 * 子智能体内部的调用不算:它们整体就是主智能体的一步(Task)。
 */
export function workSteps(events: readonly AgentEvent[], limit = 3): WorkStep[] {
  const main = events.filter((e) => !("subagent" in e && e.subagent));

  let plan: Todo[] | null = null;
  for (const e of main) {
    if (e.kind === "tool_use" && e.tool === "TodoWrite") plan = todosOf(e.input) ?? plan;
  }
  if (plan) {
    const steps: WorkStep[] = plan.map((t) => ({
      label: clip(t.content),
      state: t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : "pending",
    }));
    let at = steps.findIndex((s) => s.state === "running");
    if (at < 0) at = steps.findIndex((s) => s.state === "pending");
    if (at < 0) at = steps.length - 1;
    const start = Math.max(0, Math.min(at - 1, steps.length - limit));
    return steps.slice(start, start + limit);
  }

  const results = new Map<string, boolean>();
  for (const e of main) {
    if (e.kind === "tool_result" && e.toolUseId) results.set(e.toolUseId, Boolean(e.isError));
  }
  const calls = main.filter(
    (e): e is Extract<AgentEvent, { kind: "tool_use" }> =>
      e.kind === "tool_use" && !NOT_A_STEP.has(e.tool),
  );
  return calls.slice(-limit).map((c, i, list) => {
    const result = c.toolUseId ? results.get(c.toolUseId) : undefined;
    const last = i === list.length - 1;
    return {
      label: stepLabel(c.tool, c.input),
      state: result === true ? "error" : result === false || !last ? "done" : "running",
    };
  });
}
