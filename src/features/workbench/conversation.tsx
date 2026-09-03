"use client";

import type { AgentEvent } from "@/lib/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ProcessBlock,
  type ScrollMode,
  type ToolCall,
  foldEvents,
  formatTokens,
  processBlocks,
  sumUsage,
  totalUsageTokens,
  transitionScrollMode,
} from "./conversation.logic";
import type { Turn } from "./types";

export {
  contextTokens,
  foldEvents,
  formatTokens,
  processBlocks,
  sumUsage,
  totalUsageTokens,
  transitionScrollMode,
} from "./conversation.logic";

import { MessageResponse } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CopyIcon,
  Eye,
  HelpCircle,
  RotateCcw,
  Search,
  SquarePen,
  Terminal as TerminalIcon,
  Wrench,
  X,
} from "lucide-react";

// ─────────────────────────── 工具函数 ───────────────────────────

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

const SHELL_TOOLS = new Set(["bash", "bashoutput"]);

function toolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  if (SHELL_TOOLS.has(lower)) return TerminalIcon;
  if (lower.includes("agent") || lower.includes("task") || lower.includes("delegate")) return Bot;
  if (lower.includes("read") || lower.includes("view")) return Eye;
  if (lower.includes("edit") || lower.includes("write") || lower.includes("create"))
    return SquarePen;
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) return Search;
  return Wrench;
}

function toolGroupSummary(calls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
  const parts = [...counts.entries()].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool));
  if (parts.length <= 3) return parts.join(", ");
  return `${parts.slice(0, 2).join(", ")} +${parts.length - 2}`;
}

function summarizeToolInput(tool: string, input: unknown): string {
  if (["EnterPlanMode", "ExitPlanMode"].includes(tool)) return "";
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  const pick = (key: string) => (typeof values[key] === "string" ? values[key] : "");
  const value =
    tool === "Bash"
      ? pick("command")
      : ["Write", "Read", "Edit", "NotebookEdit"].includes(tool)
        ? pick("file_path")
        : pick("description") || Object.keys(values).join(", ");
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
}

function summarizeThinking(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
}

function toolNameClass(tool: string): string {
  if (tool === "Bash") return "text-amber-500";
  if (["Write", "Edit", "NotebookEdit"].includes(tool)) return "text-emerald-500";
  if (["Read", "Glob", "Grep"].includes(tool)) return "text-sky-500";
  if (["Agent", "Task"].includes(tool)) return "text-cyan-500";
  if (["EnterPlanMode", "ExitPlanMode"].includes(tool)) return "text-violet-500";
  if (tool === "AskUserQuestion") return "text-yellow-500";
  return "text-muted-foreground";
}

function modeToolLabel(tool: string): string {
  return tool;
}

// ─────────────────────────── t3code 风格子组件 ───────────────────────────

function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatWorkingTimerNow(createdAt);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

function ActivityShimmerOverlay({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="block text-foreground">{children}</span>
    </span>
  );
}

function LiveActivityRow({ label, icon: Icon }: { label: string; icon?: React.ElementType }) {
  return (
    <div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
      <span className="flex min-h-6 min-w-0 items-center gap-1.5 px-0.5 py-0.5 text-muted-foreground/60">
        {Icon && (
          <span className="flex size-6 shrink-0 items-center justify-center opacity-70">
            <Icon className="size-4 shrink-0 stroke-[1.8]" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
      <ActivityShimmerOverlay>
        <span className="flex min-h-6 min-w-0 items-center gap-1.5 px-0.5 py-0.5 text-foreground">
          {Icon && (
            <span className="flex size-6 shrink-0 items-center justify-center">
              <Icon className="size-4 shrink-0 stroke-[1.8]" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </span>
      </ActivityShimmerOverlay>
    </div>
  );
}

const ThinkingSection = memo(function ThinkingSection({
  label,
  text,
  running,
  expanded,
  onToggle,
}: {
  label: string;
  text: string;
  running: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <div className="pb-1.5">
      <button
        type="button"
        className="group/thinking flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
          {expanded ? (
            <ChevronDown className="size-3.5 stroke-[1.8]" />
          ) : (
            <ChevronRight className="size-3.5 stroke-[1.8]" />
          )}
        </span>
        <Brain className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
        <span
          className={cn(
            "relative min-w-0 flex-1 truncate text-muted-foreground",
            running && "live-activity-focus",
          )}
        >
          {label}
        </span>
      </button>
      {expanded && (
        <div className="ml-12 whitespace-pre-wrap border-l border-border/60 py-1 pl-3 text-xs leading-relaxed text-muted-foreground">
          {text || (running ? "正在思考..." : "没有可显示的思考内容")}
        </div>
      )}
    </div>
  );
});

// ─────────────────────────── 工具分组 ───────────────────────────

const ToolGroupSection = memo(function ToolGroupSection({
  calls,
  running,
  expanded,
  onToggle,
}: {
  calls: ToolCall[];
  running: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  if (calls.length === 0) return null;

  if (running) {
    const completedCalls = calls.filter((c) => c.result);
    const pendingCall = calls.find((c) => !c.result);
    const summary = pendingCall
      ? `Running ${pendingCall.tool}`
      : `Ran ${calls.length} ${calls.length === 1 ? "tool" : "tools"}`;

    return (
      <div className="space-y-1 pb-1.5">
        <button
          type="button"
          className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
            {expanded ? (
              <ChevronDown className="size-3.5 stroke-[1.8]" />
            ) : (
              <ChevronRight className="size-3.5 stroke-[1.8]" />
            )}
          </span>
          <Wrench className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        </button>
        {!expanded && pendingCall && (
          <LiveActivityRow
            label={
              SHELL_TOOLS.has(pendingCall.tool.toLowerCase()) &&
              pendingCall.input &&
              typeof pendingCall.input === "object" &&
              "command" in pendingCall.input
                ? `Running ${String((pendingCall.input as { command: unknown }).command).split(" ")[0] ?? pendingCall.tool}`
                : `Running ${pendingCall.tool}`
            }
            icon={toolIcon(pendingCall.tool)}
          />
        )}
        {expanded && (
          <div className="space-y-1 pl-1">
            {completedCalls.map((call, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: tool calls append-only during streaming
                key={`done-${i}`}
                className="space-y-1"
              >
                <div className="flex min-h-6 items-center gap-1.5 px-0.5 text-sm text-muted-foreground">
                  <span className="flex size-6 shrink-0 items-center justify-center">
                    {(() => {
                      const Icon = toolIcon(call.tool);
                      return <Icon className="size-4 stroke-[1.8] opacity-70" />;
                    })()}
                  </span>
                  <code className="min-w-0 truncate text-xs">
                    {call.input && typeof call.input === "object" && "command" in call.input
                      ? String((call.input as { command: unknown }).command)
                      : call.tool}
                  </code>
                </div>
                {call.result?.text && (
                  <pre className="ml-7 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                    {call.result.text.slice(0, 2000)}
                  </pre>
                )}
              </div>
            ))}
            {pendingCall && (
              <div className="ml-7 rounded bg-muted/20 p-2 text-xs text-muted-foreground">
                Running {pendingCall.tool}...
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const summary =
    calls.length === 1
      ? `Ran ${calls[0]?.tool ?? "tool"}`
      : `Ran ${calls.length} tools · ${toolGroupSummary(calls)}`;
  const failed = calls.some((c) => c.result?.isError);
  const Icon = calls.length === 1 ? toolIcon(calls[0]?.tool ?? "") : Wrench;

  return (
    <div className="pb-2">
      <button
        type="button"
        className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
          {expanded ? (
            <ChevronDown className="size-3.5 stroke-[1.8]" />
          ) : (
            <ChevronRight className="size-3.5 stroke-[1.8]" />
          )}
        </span>
        <Icon className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            failed ? "text-destructive/80" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1 pl-1">
          {calls.map((call, i) => {
            const CallIcon = toolIcon(call.tool);
            const callLabel = call.subagent ? `[${call.subagent}] ${call.tool}` : call.tool;
            const isShell =
              SHELL_TOOLS.has(call.tool.toLowerCase()) &&
              call.input &&
              typeof call.input === "object" &&
              "command" in call.input;
            const commandText = isShell
              ? String((call.input as { command: unknown }).command)
              : null;

            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: tool calls have no stable id
              <div key={`tool-${i}`} className="space-y-1">
                <div className="flex min-h-6 items-center gap-1.5 px-0.5 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
                    <CallIcon className="size-4 stroke-[1.8] opacity-70" />
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      call.result?.isError ? "text-destructive/80" : "text-muted-foreground",
                    )}
                  >
                    {commandText ? (
                      <code className="font-mono text-xs">{commandText}</code>
                    ) : (
                      callLabel
                    )}
                  </span>
                </div>
                {call.result?.text && (
                  <div className="ml-7 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                    {call.result.text.slice(0, 2000)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const ToolCallRow = memo(function ToolCallRow({
  call,
  running,
}: {
  call: ToolCall;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isModeTool = ["EnterPlanMode", "ExitPlanMode"].includes(call.tool);
  const callLabel = call.subagent ? `[${call.subagent}] ${call.tool}` : call.tool;
  const inputText = !isModeTool && call.input != null ? JSON.stringify(call.input, null, 2) : null;
  const inputSummary = summarizeToolInput(call.tool, call.input);
  const resultSummary = isModeTool ? summarizeThinking(call.result?.text ?? "") : "";
  const CallIcon = toolIcon(call.tool);
  const hasDetails = inputText != null || call.result?.text != null || !call.result;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className={cn(
          "flex min-h-6 w-full items-center gap-1.5 rounded-md px-0.5 text-left text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          hasDetails && "cursor-pointer transition-colors hover:bg-accent/40",
        )}
        onClick={() => {
          if (hasDetails) setExpanded((current) => !current);
        }}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
          {hasDetails && expanded ? (
            <ChevronDown className="size-3.5 stroke-[1.8]" />
          ) : hasDetails ? (
            <ChevronRight className="size-3.5 stroke-[1.8]" />
          ) : null}
        </span>
        <CallIcon className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            call.result?.isError ? "text-destructive/80" : "text-muted-foreground",
            running && !call.result && "live-activity-focus",
          )}
        >
          <span
            className={cn(
              "font-medium",
              call.result?.isError ? "text-destructive" : toolNameClass(call.tool),
            )}
          >
            {isModeTool ? modeToolLabel(call.tool) : callLabel}
          </span>
          {(inputSummary || resultSummary) && (
            <code className="ml-1 font-mono text-xs text-muted-foreground/80">
              ({inputSummary || resultSummary})
            </code>
          )}
          {call.result?.isError && <span className="ml-1 text-xs text-destructive">failed</span>}
        </span>
      </button>
      {expanded && (
        <div className="ml-7 space-y-1">
          {inputText && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/20 p-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
              {inputText}
            </pre>
          )}
          {call.result?.text && (
            <pre
              className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 font-mono text-[0.6875rem] leading-relaxed",
                call.result.isError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <span className="mr-1 text-muted-foreground/50">⎿</span>
              {call.result.text.slice(0, 2000)}
            </pre>
          )}
          {!call.result && (
            <p className="rounded bg-muted/20 p-2 text-xs text-muted-foreground">Running...</p>
          )}
        </div>
      )}
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({
  text,
  running,
}: {
  text: string;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeThinking(text);

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
          {expanded ? (
            <ChevronDown className="size-3.5 stroke-[1.8]" />
          ) : (
            <ChevronRight className="size-3.5 stroke-[1.8]" />
          )}
        </span>
        <Brain className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
        <span className={cn("min-w-0 flex-1 truncate", running && "live-activity-focus")}>
          Thinking
          {summary && (
            <code className="ml-1 font-mono text-xs text-muted-foreground/80">({summary})</code>
          )}
        </span>
      </button>
      {expanded && (
        <div className="ml-7 max-h-64 whitespace-pre-wrap break-words border-l border-border/60 pl-3 text-xs leading-relaxed text-muted-foreground">
          {text || (running ? "正在思考..." : "没有可显示的思考内容")}
        </div>
      )}
    </div>
  );
});

const ActivitySection = memo(function ActivitySection({
  items,
  running,
  expanded,
  onToggle,
}: {
  items: Extract<ProcessBlock, { kind: "activity" }>["items"];
  running: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const calls = items.filter(
    (item): item is Extract<(typeof items)[number], { kind: "tool" }> => item.kind === "tool",
  );
  const pendingCall = calls.findLast((item) => !item.call.result)?.call;
  const failedCount = calls.filter((item) => item.call.result?.isError).length;
  const latestItem = items.at(-1);
  const latestThinking = latestItem?.kind === "thinking" ? latestItem.text : "";
  const latestThinkingSummary = summarizeThinking(latestThinking);
  const runningLabel =
    latestItem?.kind === "thinking"
      ? latestThinkingSummary
        ? `Thinking (${latestThinkingSummary})`
        : "Thinking"
      : pendingCall
        ? `Running ${pendingCall.tool}`
        : null;
  const summary = pendingCall
    ? (runningLabel ?? `Running ${pendingCall.tool}`)
    : calls.length > 0
      ? calls.length === 1
        ? `Ran ${calls[0]?.call.tool ?? "tool"}${failedCount > 0 ? " · failed" : ""}`
        : `Ran ${calls.length} tools · ${toolGroupSummary(calls.map((item) => item.call))}${
            failedCount > 0 ? ` · ${failedCount} failed` : ""
          }`
      : "Thinking";
  const SummaryIcon =
    latestItem?.kind === "thinking"
      ? Brain
      : latestItem?.kind === "tool"
        ? toolIcon(latestItem.call.tool)
        : pendingCall
          ? toolIcon(pendingCall.tool)
          : calls.length === 1
            ? toolIcon(calls[0]?.call.tool ?? "")
            : calls.length > 1
              ? Wrench
              : Brain;

  return (
    <div className="pb-1.5">
      <button
        type="button"
        className="group/activity flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 text-left text-sm transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
          {expanded ? (
            <ChevronDown className="size-3.5 stroke-[1.8]" />
          ) : (
            <ChevronRight className="size-3.5 stroke-[1.8]" />
          )}
        </span>
        <SummaryIcon className="size-4 shrink-0 stroke-[1.8] text-muted-foreground/60" />
        <span className={cn("min-w-0 flex-1 truncate", running && "live-activity-focus")}>
          {summary}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1 pl-1">
          {items.map((item, index) => {
            if (item.kind === "thinking") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: activity items are append-only during streaming
                <div key={`thinking-${index}`}>
                  <ThinkingRow text={item.text} running={running} />
                </div>
              );
            }

            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: activity items are append-only during streaming
              <div key={`tool-${index}`} className="space-y-1">
                <ToolCallRow call={item.call} running={running && item.call === pendingCall} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

type QuestionEvent = Extract<AgentEvent, { kind: "question" }>;

function QuestionBlock({
  e,
  answerable,
  onAnswer,
}: {
  e: QuestionEvent;
  answerable: boolean;
  onAnswer?: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        if (cur.has(label)) cur.clear();
        else {
          cur.clear();
          cur.add(label);
        }
      }
      return { ...prev, [qi]: cur };
    });
  };

  const answered = e.questions.map((_, i) => [...(picked[i] ?? [])]);
  const complete = answered.every((a) => a.length > 0);

  const submit = () => {
    if (!complete || !onAnswer) return;
    const text = e.questions
      .map((q, i) => {
        const ans = answered[i]?.join("、") ?? "";
        return e.questions.length > 1 ? `${q.header ?? q.question}:${ans}` : ans;
      })
      .join("\n");
    onAnswer(text);
  };

  return (
    <Card className="border-blue-500/25 bg-blue-500/[0.04]">
      <CardContent className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">
          <HelpCircle className="mr-1 inline-block h-3 w-3" />
          智能体在等你选择
        </p>
        {e.questions.map((q, qi) => (
          <div key={`${q.question}-${qi}`} className="space-y-2">
            <p className="text-sm font-medium">
              {q.question}
              {q.multiSelect && (
                <span className="ml-2 text-xs text-muted-foreground">(可多选)</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => {
                const on = (picked[qi] ?? new Set()).has(o.label);
                return (
                  <Button
                    key={o.label}
                    type="button"
                    variant={on ? "default" : "outline"}
                    size="sm"
                    disabled={!answerable}
                    title={o.description}
                    onClick={() => toggle(qi, o.label, q.multiSelect === true)}
                    className="rounded-full"
                  >
                    {o.label}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
        {answerable ? (
          <Button type="button" onClick={submit} disabled={!complete} size="sm">
            {complete ? "发送选择" : "请先选择"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">历史提问,已由后续对话回答</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── 单轮渲染（memo 化） ───────────────────────────

const TurnView = memo(function TurnView({
  turn,
  turnKey,
  isLastTurn,
  expandedBlockIds,
  onToggleBlock,
  onRerunAction,
  onAnswerAction,
}: {
  turn: Turn;
  turnKey: string;
  isLastTurn: boolean;
  expandedBlockIds: ReadonlySet<string>;
  onToggleBlock(blockId: string): void;
  onRerunAction?: (runId: string, prompt: string) => void;
  onAnswerAction?: (text: string) => void;
}) {
  const { usage, blocks, questions, resultEvent, allText } = useMemo(() => {
    const items = foldEvents(turn.events);
    const nextBlocks = processBlocks(items);
    const nextQuestions: QuestionEvent[] = [];
    let nextResultEvent: Extract<AgentEvent, { kind: "result" }> | null = null;

    for (const item of items) {
      if (item.kind !== "event") continue;
      const event = item.event;
      if (event.kind === "question") nextQuestions.push(event);
      if (event.kind === "result" && (event.status !== "success" || event.structured != null)) {
        nextResultEvent = event;
      }
    }

    return {
      usage: sumUsage(turn.events),
      blocks: nextBlocks,
      questions: nextQuestions,
      resultEvent: nextResultEvent,
      allText: nextBlocks
        .filter((block): block is Extract<ProcessBlock, { kind: "text" }> => block.kind === "text")
        .map((block) => block.text)
        .join(""),
    };
  }, [turn.events]);

  return (
    <div className="space-y-1">
      {turn.branchedFrom && (
        <p className="pb-1 text-xs text-muted-foreground">⑂ 从上文某轮分叉重跑</p>
      )}

      {/* 用户消息 — t3code 风格右对齐圆角气泡 */}
      <div className="flex justify-end pb-4">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-message px-4 py-2.5 text-sm text-foreground">
          {turn.prompt}
        </div>
      </div>

      {/* Working for Xs — t3code 风格分隔线 + 计时 */}
      {turn.running && turn.startedAt && (
        <div className="border-b border-border/60 pb-2 pt-1">
          <div className="flex h-6 min-w-0 items-baseline px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
            <span className="shrink-0 whitespace-nowrap">
              Working for <WorkingTimer createdAt={turn.startedAt} />
            </span>
          </div>
        </div>
      )}

      {/* 过程按事件顺序渲染；只把相邻工具调用折成一组。 */}
      {blocks.map((block, blockIndex) => {
        const blockId = `${turnKey}:${blockIndex}:${block.kind}`;
        if (block.kind === "activity") {
          if (block.items.length === 1) {
            const item = block.items[0];
            if (item?.kind === "thinking") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
                <div key={`thinking-${blockIndex}`} className="pb-1.5">
                  <ThinkingRow text={item.text} running={turn.running} />
                </div>
              );
            }
            if (item?.kind === "tool") {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
                <div key={`tool-${blockIndex}`} className="pb-1.5">
                  <ToolCallRow call={item.call} running={turn.running} />
                </div>
              );
            }
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
            <div key={`activity-${blockIndex}`}>
              <ActivitySection
                items={block.items}
                running={turn.running}
                expanded={expandedBlockIds.has(blockId)}
                onToggle={() => onToggleBlock(blockId)}
              />
            </div>
          );
        }
        if (block.kind === "status") {
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
              key={`status-${blockIndex}`}
              className="flex min-h-7 items-center gap-2 px-1 pb-1 text-xs text-muted-foreground"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-current opacity-50" />
              <span>{block.label}</span>
            </div>
          );
        }
        if (block.kind === "tool-result") {
          return (
            <pre
              // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
              key={`orphan-tool-result-${blockIndex}`}
              className={cn(
                "mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 font-mono text-[0.6875rem] leading-relaxed",
                block.isError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {block.text.slice(0, 2000)}
            </pre>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: process blocks append in event order
          <div key={`text-${blockIndex}`} className="group/assistant pb-4">
            <div className="relative min-w-0 px-1 py-0.5">
              <MessageResponse isAnimating={turn.running}>{block.text}</MessageResponse>
            </div>
          </div>
        );
      })}

      {!turn.running && (allText || (turn.runId && onRerunAction)) && (
        <div className="-mt-3 flex items-center gap-2 px-1 pb-3 text-xs opacity-100 transition-opacity duration-200 sm:opacity-0 sm:focus-within:opacity-100 sm:hover:opacity-100">
          {allText && (
            <button
              type="button"
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                void navigator.clipboard.writeText(allText).then(
                  () => toast.success("回复已复制"),
                  () => toast.error("复制失败，请手动选择文本"),
                );
              }}
            >
              <CopyIcon className="size-3" />
              <span>复制</span>
            </button>
          )}
          {turn.runId && onRerunAction && (
            <button
              type="button"
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                const next = window.prompt("重跑这一轮(干净上下文),换个说法:", turn.prompt);
                if (next?.trim() && turn.runId) onRerunAction(turn.runId, next.trim());
              }}
            >
              <RotateCcw className="size-3" />
              <span>重跑</span>
            </button>
          )}
        </div>
      )}

      {/* 提问卡片 */}
      {questions.map((q, qi) => (
        <div key={q.toolUseId ?? `q-${qi}`} className="pb-4">
          <QuestionBlock
            e={q}
            answerable={isLastTurn && !turn.running && !!onAnswerAction}
            onAnswer={onAnswerAction}
          />
        </div>
      ))}

      {/* 终态(仅失败/未知/结构化) */}
      {resultEvent && (
        <div className="pb-4">
          <Card className="overflow-hidden">
            <CardContent className="flex items-start gap-2 p-2 text-sm">
              <Badge
                variant={
                  resultEvent.status === "success"
                    ? "success"
                    : resultEvent.status === "unknown"
                      ? "warning"
                      : resultEvent.status === "cancelled"
                        ? "secondary"
                        : "destructive"
                }
              >
                {resultEvent.status === "success" ? (
                  <>
                    <Check className="mr-1 inline-block h-3 w-3" /> 完成
                  </>
                ) : resultEvent.status === "unknown" ? (
                  <>
                    <AlertTriangle className="mr-1 inline-block h-3 w-3" /> 结局未知
                  </>
                ) : resultEvent.status === "cancelled" ? (
                  <>
                    <X className="mr-1 inline-block h-3 w-3" /> 已取消
                  </>
                ) : (
                  <>
                    <X className="mr-1 inline-block h-3 w-3" /> 失败
                  </>
                )}
              </Badge>
              {resultEvent.summary && resultEvent.status !== "success" && (
                <span className="opacity-80">{resultEvent.summary}</span>
              )}
            </CardContent>
            {resultEvent.structured != null && (
              <CardContent className="p-2 pt-0">
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                  {JSON.stringify(resultEvent.structured, null, 2)}
                </pre>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      {/* 用量页脚 — pill 样式 */}
      {!turn.running && (usage.input > 0 || usage.output > 0) && (
        <div className="pb-2">
          <span className="inline-flex items-center rounded-full border border-border/60 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            ↑{formatTokens(usage.input)} ↓{formatTokens(usage.output)}
          </span>
        </div>
      )}
    </div>
  );
});

// ─────────────────────────── 主组件 ───────────────────────────

export function scrollModeForDistance(distanceFromEnd: number): ScrollMode {
  if (distanceFromEnd <= 48) return "following";
  if (distanceFromEnd <= 320) return "anchoring";
  return "free";
}

export function ChatThread({
  turns,
  onRerunAction,
  onAnswerAction,
}: {
  turns: Turn[];
  onRerunAction?: (runId: string, prompt: string) => void;
  onAnswerAction?: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollMode, setScrollMode] = useState<ScrollMode>("following");
  const [expandedBlockIds, setExpandedBlockIds] = useState<Set<string>>(() => new Set());
  const previousTurnCountRef = useRef(turns.length);
  const previousLastRunningRef = useRef(turns.at(-1)?.running === true);
  const appendedTurn = turns.length > previousTurnCountRef.current;
  const anchorAppendedTurn = appendedTurn && scrollMode === "following";
  const totalEvents = useMemo(
    () => turns.reduce((sum, turn) => sum + turn.events.length, 0),
    [turns],
  );
  const virtualizer = useVirtualizer({
    count: turns.length,
    useFlushSync: false,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 280,
    overscan: 4,
    scrollPaddingStart: 24,
    paddingEnd: 176,
    scrollPaddingEnd: 176,
    anchorTo: "end",
    followOnAppend: scrollMode === "following" && !anchorAppendedTurn ? "auto" : false,
    scrollEndThreshold: 48,
    getItemKey: (index) => turns[index]?.localId ?? turns[index]?.runId ?? `turn-${index}`,
  });

  const scrollToEnd = useCallback(
    (smooth = true) => {
      if (turns.length === 0) return;
      setScrollMode("following");
      virtualizer.scrollToIndex(turns.length - 1, {
        align: "end",
        behavior: smooth ? "smooth" : "auto",
      });
    },
    [turns.length, virtualizer],
  );

  const onToggleBlock = useCallback((blockId: string) => {
    setExpandedBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const previousCount = previousTurnCountRef.current;
    previousTurnCountRef.current = turns.length;
    if (turns.length <= previousCount || scrollMode !== "following") return;

    setScrollMode((current) => transitionScrollMode(current, { kind: "new-turn" }));
    const index = turns.length - 1;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
    });
  }, [scrollMode, turns.length, virtualizer]);

  const lastRunning = turns.at(-1)?.running === true;
  useLayoutEffect(() => {
    const wasRunning = previousLastRunningRef.current;
    previousLastRunningRef.current = lastRunning;
    if (!wasRunning || lastRunning) return;

    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setScrollMode((current) =>
        transitionScrollMode(current, { kind: "run-ended", distanceFromEnd: distance }),
      );
    });
  }, [lastRunning]);

  const minimapIndexes = useMemo(() => {
    if (turns.length <= 80) return turns.map((_, index) => index);
    const step = Math.ceil(turns.length / 80);
    const indexes = turns.flatMap((_, index) => (index % step === 0 ? [index] : []));
    if (indexes.at(-1) !== turns.length - 1) indexes.push(turns.length - 1);
    return indexes;
  }, [turns]);

  const lastFollowedEventCount = useRef(-1);
  useEffect(() => {
    if (scrollMode !== "following" || lastFollowedEventCount.current === totalEvents) return;
    lastFollowedEventCount.current = totalEvents;
    requestAnimationFrame(() => scrollToEnd(false));
  }, [totalEvents, scrollMode, scrollToEnd]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setScrollMode((current) =>
      transitionScrollMode(current, { kind: "distance-change", distanceFromEnd: distance }),
    );
  }, []);

  const enterFreeScrolling = useCallback(() => {
    setScrollMode((current) => transitionScrollMode(current, { kind: "user-navigation" }));
  }, []);

  if (turns.length === 0) return null;

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        data-conversation-scroll=""
        onScroll={onScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) enterFreeScrolling();
        }}
        onTouchMove={enterFreeScrolling}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) enterFreeScrolling();
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) enterFreeScrolling();
        }}
        className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
      >
        <div
          className="relative mx-auto w-full max-w-3xl"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualItems.map((virtualRow) => {
            const turn = turns[virtualRow.index];
            if (!turn) return null;
            const turnKey = String(virtualRow.key);
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full pb-2 pt-6"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TurnView
                  turn={turn}
                  turnKey={turnKey}
                  isLastTurn={virtualRow.index === turns.length - 1}
                  expandedBlockIds={expandedBlockIds}
                  onToggleBlock={onToggleBlock}
                  onRerunAction={onRerunAction}
                  onAnswerAction={onAnswerAction}
                />
              </div>
            );
          })}
        </div>
      </div>

      <nav
        aria-label="对话轮次导航"
        className="absolute left-1 top-1/2 z-10 hidden max-h-48 -translate-y-1/2 flex-col gap-1 overflow-y-auto rounded bg-background/80 p-1 backdrop-blur-sm md:flex"
      >
        {minimapIndexes.map((index) => {
          const turn = turns[index];
          if (!turn) return null;
          return (
            <button
              key={turn.runId ?? `turn-${index}`}
              type="button"
              className={cn(
                "size-1.5 shrink-0 rounded-full bg-muted-foreground/30 transition-[transform,background-color] hover:scale-150 hover:bg-foreground/70",
                turn.running && "bg-brand",
              )}
              title={`第 ${index + 1} 轮: ${turn.prompt.slice(0, 40)}`}
              aria-label={`跳到第 ${index + 1} 轮`}
              onClick={() => {
                enterFreeScrolling();
                virtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
              }}
            />
          );
        })}
      </nav>

      {scrollMode !== "following" && (
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="absolute bottom-36 right-5 z-20 size-9 rounded-full shadow-md"
          title="回到最新消息"
          aria-label="回到最新消息"
          onClick={() => scrollToEnd(true)}
        >
          <ArrowDown className="size-4" />
        </Button>
      )}
    </div>
  );
}
