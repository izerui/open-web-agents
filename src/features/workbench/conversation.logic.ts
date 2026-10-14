import type { AgentEvent } from "@/lib/shared";
import type { Turn } from "./types";

export interface ToolCall {
  kind: "tool";
  tool: string;
  input: unknown;
  result?: { text: string; isError: boolean };
  subagent?: string;
}

export type Rendered = ToolCall | { kind: "event"; event: AgentEvent };

export type ProcessBlock =
  | {
      kind: "activity";
      items: Array<
        { kind: "thinking"; text: string; subagent?: string } | { kind: "tool"; call: ToolCall }
      >;
    }
  | { kind: "text"; text: string }
  | { kind: "status"; label: string; state?: string }
  | { kind: "tool-result"; text: string; isError: boolean }
  /** 运行中途追加的消息,按交给模型的时刻出现在过程里 */
  | { kind: "steer"; text: string; outcome: "delivered" | "dropped" };

export type ScrollMode = "following" | "anchoring" | "free";

export type ScrollModeEvent =
  | { kind: "new-turn" }
  | { kind: "user-navigation" }
  | { kind: "distance-change"; distanceFromEnd: number }
  | { kind: "run-ended"; distanceFromEnd: number };

export function transitionScrollMode(current: ScrollMode, event: ScrollModeEvent): ScrollMode {
  if (event.kind === "new-turn") {
    return current === "following" ? "anchoring" : current;
  }
  if (event.kind === "user-navigation") {
    return "free";
  }
  if (event.distanceFromEnd <= 48) {
    return "following";
  }
  if (event.kind === "run-ended" && current === "anchoring") {
    return "free";
  }
  return current;
}

export function foldEvents(events: AgentEvent[]): Rendered[] {
  const out: Rendered[] = [];
  const byToolId = new Map<string, ToolCall>();

  for (const event of events) {
    if (event.kind === "tool_use") {
      const call: ToolCall = {
        kind: "tool",
        tool: event.tool,
        input: event.input,
        subagent: event.subagent,
      };
      if (event.toolUseId) byToolId.set(event.toolUseId, call);
      out.push(call);
    } else if (event.kind === "tool_result") {
      const call = event.toolUseId ? byToolId.get(event.toolUseId) : undefined;
      if (call) call.result = { text: event.text, isError: event.isError === true };
      else out.push({ kind: "event", event });
    } else if (event.kind === "usage") {
      // Usage is rendered once in the turn footer.
    } else if (event.kind === "text" || event.kind === "thinking") {
      const previous = out.at(-1);
      const previousSubagent =
        previous?.kind === "event" && "subagent" in previous.event
          ? previous.event.subagent
          : undefined;
      const nextSubagent = "subagent" in event ? event.subagent : undefined;
      if (
        previous?.kind === "event" &&
        previous.event.kind === event.kind &&
        previousSubagent === nextSubagent
      ) {
        (previous.event as { text: string }).text += event.text;
      } else {
        out.push({ kind: "event", event: { ...event } });
      }
    } else {
      out.push({ kind: "event", event });
    }
  }
  return out;
}

const TRANSIENT_STATUS_STATES = new Set(["pending", "running"]);
const TRANSIENT_STATUS_LABELS = new Set(["已入队", "运行中"]);

function shouldDisplayStatus(label: string, state?: string): boolean {
  return !TRANSIENT_STATUS_LABELS.has(label) && !TRANSIENT_STATUS_STATES.has(state ?? "");
}

export function processBlocks(items: Rendered[]): ProcessBlock[] {
  const blocks: ProcessBlock[] = [];
  const activityItems: Array<
    { kind: "thinking"; text: string; subagent?: string } | { kind: "tool"; call: ToolCall }
  > = [];
  const flushActivity = () => {
    if (activityItems.length === 0) return;
    blocks.push({ kind: "activity", items: activityItems.splice(0) });
  };

  for (const item of items) {
    if (item.kind === "tool") {
      activityItems.push({ kind: "tool", call: item });
      continue;
    }
    if (item.event.kind === "text") {
      flushActivity();
      blocks.push({ kind: "text", text: item.event.text });
    } else if (item.event.kind === "thinking") {
      activityItems.push({
        kind: "thinking",
        text: item.event.text,
        subagent: item.event.subagent,
      });
    } else if (
      item.event.kind === "status" &&
      shouldDisplayStatus(item.event.label, item.event.state)
    ) {
      flushActivity();
      blocks.push({ kind: "status", label: item.event.label, state: item.event.state });
    } else if (item.event.kind === "steer") {
      flushActivity();
      blocks.push({ kind: "steer", text: item.event.text, outcome: item.event.outcome });
    } else if (item.event.kind === "tool_result") {
      flushActivity();
      blocks.push({
        kind: "tool-result",
        text: item.event.text,
        isError: item.event.isError === true,
      });
    }
  }
  flushActivity();
  return blocks;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function usageTotals(event: Extract<AgentEvent, { kind: "usage" }>): UsageTotals {
  return {
    input: event.input,
    output: event.output,
    cacheRead: event.cacheRead ?? 0,
    cacheCreation: event.cacheCreation ?? 0,
  };
}

export function sumUsage(events: AgentEvent[]): UsageTotals {
  const latest = new Map<string, UsageTotals>();
  let anonymousInput = 0;
  let anonymousOutput = 0;
  let anonymousCacheRead = 0;
  let anonymousCacheCreation = 0;
  for (const event of events) {
    if (event.kind !== "usage") continue;
    if (event.messageId) latest.set(event.messageId, usageTotals(event));
    else {
      anonymousInput += event.input;
      anonymousOutput += event.output;
      anonymousCacheRead += event.cacheRead ?? 0;
      anonymousCacheCreation += event.cacheCreation ?? 0;
    }
  }
  let input = anonymousInput;
  let output = anonymousOutput;
  let cacheRead = anonymousCacheRead;
  let cacheCreation = anonymousCacheCreation;
  for (const usage of latest.values()) {
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheCreation += usage.cacheCreation;
  }
  return { input, output, cacheRead, cacheCreation };
}

export function totalUsageTokens(usage: UsageTotals): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
}

/**
 * 当前上下文占用 = 【最近一次模型调用】的输入(含缓存读写)+ 输出。
 *
 * 每次调用都带着完整上下文,所以一轮里有几次调用(工具来回),输入就被重复算几次。
 * 曾经把一轮里所有调用的 input 累加,5 步工具调用的一轮会显示成 5 倍上下文,
 * 计量环动不动就虚报到 90% 以上。累加值是计费口径,不是占用口径。
 */
export function contextTokens(turns: Turn[]): number {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!turn) continue;
    for (let i = turn.events.length - 1; i >= 0; i--) {
      const e = turn.events[i];
      if (e?.kind !== "usage") continue;
      const total = e.input + (e.cacheRead ?? 0) + (e.cacheCreation ?? 0) + e.output;
      if (total > 0) return total;
    }
  }
  return 0;
}
