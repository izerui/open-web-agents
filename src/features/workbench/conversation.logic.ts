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
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; subagent?: string }
  | { kind: "status"; label: string; state?: string }
  | { kind: "tool-result"; text: string; isError: boolean };

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
  let tools: ToolCall[] = [];
  const flushTools = () => {
    if (tools.length === 0) return;
    blocks.push({ kind: "tools", calls: tools });
    tools = [];
  };

  for (const item of items) {
    if (item.kind === "tool") {
      tools.push(item);
      continue;
    }
    flushTools();
    if (item.event.kind === "text") {
      blocks.push({ kind: "text", text: item.event.text });
    } else if (item.event.kind === "thinking") {
      blocks.push({
        kind: "thinking",
        text: item.event.text,
        subagent: item.event.subagent,
      });
    } else if (
      item.event.kind === "status" &&
      shouldDisplayStatus(item.event.label, item.event.state)
    ) {
      blocks.push({ kind: "status", label: item.event.label, state: item.event.state });
    } else if (item.event.kind === "tool_result") {
      blocks.push({
        kind: "tool-result",
        text: item.event.text,
        isError: item.event.isError === true,
      });
    }
  }
  flushTools();
  return blocks;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function sumUsage(events: AgentEvent[]): { input: number; output: number } {
  const latest = new Map<string, { input: number; output: number }>();
  let anonymousInput = 0;
  let anonymousOutput = 0;
  for (const event of events) {
    if (event.kind !== "usage") continue;
    if (event.messageId) latest.set(event.messageId, { input: event.input, output: event.output });
    else {
      anonymousInput += event.input;
      anonymousOutput += event.output;
    }
  }
  let input = anonymousInput;
  let output = anonymousOutput;
  for (const usage of latest.values()) {
    input += usage.input;
    output += usage.output;
  }
  return { input, output };
}

export function contextTokens(turns: Turn[]): number {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (!turn) continue;
    const { input } = sumUsage(turn.events);
    if (input > 0) return input;
  }
  return 0;
}
