"use client";

import type { AgentEvent } from "@/lib/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { joinPromptAttachments, splitPromptAttachments } from "./chat-view.logic";
import {
  type ProcessBlock,
  type ScrollMode,
  type ToolCall,
  foldEvents,
  processBlocks,
  sumUsage,
  toolLocator,
  transitionScrollMode,
  turnKeyOf,
} from "./conversation.logic";
import {
  type AnswerEvent,
  type PendingAsk,
  type QuestionEvent,
  type QuestionState,
  answerText,
  questionState,
} from "./question-state";
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

import { AgentAvatar } from "@/components/agent-avatar";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Coins,
  CopyIcon,
  Eye,
  File,
  GitBranch,
  Minus,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  SquarePen,
  Terminal as TerminalIcon,
  Wrench,
  X,
} from "lucide-react";
import { CallStateIcon, Spin, callStateOf } from "./chat-bits";

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

export function toolIcon(toolName: string) {
  const lower = toolName.toLowerCase();
  if (SHELL_TOOLS.has(lower)) return TerminalIcon;
  if (lower.includes("agent") || lower.includes("task") || lower.includes("delegate")) return Bot;
  if (lower.includes("read") || lower.includes("view")) return Eye;
  if (lower.includes("edit") || lower.includes("write") || lower.includes("create"))
    return SquarePen;
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) return Search;
  return Wrench;
}

/**
 * 工作目录下的绝对路径在一行摘要里只剩开头可见,有用的却是结尾的文件名:
 * 超过三段的路径只留最后两段。完整参数在展开后的详情里。
 */
export function shortenPaths(text: string): string {
  return text.replace(/(?:\/[^\s/]+){3,}\/([^\s/]+\/[^\s/]+)/g, "…/$1");
}

export function summarizeToolInput(tool: string, input: unknown): string {
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

/** 工具名的区分色(深一档,保证在白底上 ≥4.5:1)。 */
export function toolNameClass(tool: string): string {
  if (tool === "Bash") return "text-warning-text";
  if (["Write", "Edit", "NotebookEdit"].includes(tool)) return "text-success-text";
  if (["Agent", "Task"].includes(tool)) return "text-ide-cyan";
  if (["EnterPlanMode", "ExitPlanMode"].includes(tool)) return "text-ide-purple";
  return "text-foreground";
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clock(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─────────────────────────── 过程块 ───────────────────────────

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

/** 思考块:左侧细线,默认收起;正在思考的那一段显示转圈。 */
const ThinkBlock = memo(function ThinkBlock({
  text,
  subagent,
  live,
}: {
  text: string;
  subagent?: string;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = subagent ? `子代理 ${subagent} 的思考` : "思考过程";
  if (live && !text.trim()) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spin />
        正在思考…
      </div>
    );
  }
  if (!text.trim()) {
    return (
      <div className="flex h-[26px] items-center gap-1.5 border-l-2 border-[#DAD6CC] pl-3 text-[13px] text-muted-foreground">
        <Sparkles className="size-3.5" />
        没有可显示的思考内容
      </div>
    );
  }
  return (
    <div className="border-l-2 border-[#DAD6CC] pl-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[26px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        {live ? <Spin className="size-3.5 border-[1.5px]" /> : <Sparkles className="size-3.5" />}
        {live ? "正在思考…" : label}
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="whitespace-pre-wrap break-words pt-0.5 pb-1 text-sm leading-[1.7] text-[#55524B]">
          {text}
        </div>
      )}
    </div>
  );
});

/** 一次调用的输入输出(没有执行详情面板时就地展开)。 */
function CallDetail({ call, running }: { call: ToolCall; running: boolean }) {
  return (
    <div className="mx-2 mb-1.5 space-y-1 rounded-lg bg-[#F6F5F1] p-2.5 text-[13px]">
      {call.subagent && <p className="text-muted-foreground">由子代理 {call.subagent} 发起</p>}
      <p className="text-xs text-muted-foreground">输入</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[13px]">
        {pretty(call.input)}
      </pre>
      <p className="text-xs text-muted-foreground">输出</p>
      <pre
        className={cn(
          "max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[13px]",
          call.result?.isError && "text-destructive",
        )}
      >
        {call.result
          ? call.result.text.slice(0, 2000) || "（空）"
          : running
            ? "运行中…"
            : "没有收到结果"}
      </pre>
    </div>
  );
}

/**
 * 工具调用卡:一行汇总(调用了几个、几个失败、几个进行中),展开后逐项列出。
 * 有执行详情面板时点一项在面板里定位;没有时(智能体设计器)就地展开输入输出。
 */
const ToolsCard = memo(function ToolsCard({
  calls,
  turnKey,
  running,
  open,
  onToggle,
  onLocate,
  selected,
  awaiting,
}: {
  awaiting?: readonly string[];
  calls: ToolCall[];
  turnKey: string;
  running: boolean;
  open: boolean;
  onToggle(): void;
  onLocate?: (locator: string) => void;
  selected?: string | null;
}) {
  const [inline, setInline] = useState<string | null>(null);
  const failed = calls.filter((c) => c.result?.isError).length;
  const live = running ? calls.filter((c) => !c.result).length : 0;
  return (
    <div className="rounded-xl border border-border bg-[#FBFAF7]">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-[38px] w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#3C3A35]"
      >
        <Wrench className="size-[15px] shrink-0" />
        <span className="min-w-0 flex-1">
          调用了 {calls.length} 个工具
          {failed > 0 ? (
            <span className="text-destructive">，{failed} 个失败</span>
          ) : live === 0 ? (
            "，全部成功"
          ) : null}
          {live > 0 && <span className="text-warning-text">，{live} 个进行中</span>}
        </span>
        {onLocate && (
          <span className="shrink-0 text-xs text-muted-foreground max-md:hidden">
            点一项在执行详情里定位
          </span>
        )}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul className="border-t border-line-soft p-1" aria-label="本轮工具调用">
          {calls.map((call) => {
            const locator = toolLocator(turnKey, call.key);
            const state = callStateOf(call, running);
            const summary = shortenPaths(summarizeToolInput(call.tool, call.input));
            const on = selected === locator || inline === locator;
            return (
              <li key={call.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    if (onLocate) onLocate(locator);
                    else setInline((cur) => (cur === locator ? null : locator));
                  }}
                  className={cn(
                    "flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[#F1EFE9]",
                    on && "bg-[#EFEDE7] shadow-[inset_3px_0_0_var(--foreground)]",
                  )}
                >
                  <CallStateIcon state={state} />
                  <span
                    className={cn(
                      "shrink-0 whitespace-nowrap font-mono text-[12.5px]",
                      state === "error" ? "text-destructive" : toolNameClass(call.tool),
                    )}
                  >
                    {call.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
                  {call.subagent && (
                    <span className="shrink-0 rounded-full border border-border px-2 text-xs leading-5 text-muted-foreground max-md:hidden">
                      由子代理 {call.subagent} 发起
                    </span>
                  )}
                  {state === "running" && awaiting?.includes(call.tool) && (
                    <span className="shrink-0 rounded-full bg-warning-soft px-2 text-xs leading-5 text-warning-text">
                      等你确认
                    </span>
                  )}
                </button>
                {!onLocate && inline === locator && <CallDetail call={call} running={running} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

/** 提交回答:回答按题目顺序;decline = 不回答。失败抛错 */
export type SubmitAnswer = (
  approvalId: string,
  body: { answers: string[] } | { decline: true },
) => Promise<void>;

function formatLeft(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const STATE_TEXT: Record<QuestionState["kind"], string> = {
  pending: "待回答",
  waiting: "等待中",
  answered: "已回答",
  declined: "未回答（你选择了不回答）",
  invalid: "提问无效",
  unanswered: "未回答",
  legacy: "历史提问",
};

/** 状态之后的一句说明 */
function stateNote(kind: QuestionState["kind"]): string {
  switch (kind) {
    case "waiting":
      return "已提交，智能体正在读取你的回答";
    case "declined":
      return "智能体按自己的判断继续";
    case "invalid":
      return "这次提问的格式不合规，没有送到你面前，智能体已继续";
    case "unanswered":
      return "没等到回答（超时或运行已停止），智能体已自行判断";
    case "legacy":
      return "来自更早的运行，只读";
    default:
      return "";
  }
}

/**
 * 智能体的提问卡片。
 *
 * 待回答:运行在原地等你(上限 10 分钟),每题可点选项,也可在"其他"里自己填写;提交后智能体在同一轮里继续。
 * 已回答 / 未回答:从运行记录里读出,刷新、翻历史都在。
 * 没等到回答(超时、停止)或旧记录、且这是最后一轮:还可以把回答当成下一条消息发出去。
 */
function QuestionBlock({
  e,
  state,
  canSendAsMessage,
  onAnswer,
  submitAnswer,
}: {
  e: QuestionEvent;
  state: QuestionState;
  /** 最后一轮、运行已结束:可以把回答当作下一条消息发出 */
  canSendAsMessage: boolean;
  onAnswer?: (text: string) => void;
  submitAnswer?: SubmitAnswer;
}) {
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = state.kind === "pending" ? state.request : null;
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending]);

  const interactive = Boolean(
    (pending && submitAnswer) ||
      ((state.kind === "unanswered" || state.kind === "legacy") && canSendAsMessage && onAnswer),
  );

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(label)) cur.delete(label);
        else cur.add(label);
      } else {
        const had = cur.has(label);
        cur.clear();
        if (!had) cur.add(label);
        // 单选:点了选项就不再用自己填写的
        setOther((o) => ({ ...o, [qi]: "" }));
        setOtherOpen((o) => ({ ...o, [qi]: false }));
      }
      return { ...prev, [qi]: cur };
    });
  };
  const toggleOther = (qi: number, multi: boolean) => {
    setOtherOpen((o) => ({ ...o, [qi]: !o[qi] }));
    if (otherOpen[qi]) setOther((o) => ({ ...o, [qi]: "" }));
    else if (!multi) setPicked((prev) => ({ ...prev, [qi]: new Set() }));
  };

  const answers = e.questions.map((_, i) => answerText([...(picked[i] ?? [])], other[i] ?? ""));
  const complete = answers.every((a) => a.length > 0);

  const submit = async () => {
    if (!complete) return;
    if (pending && submitAnswer) {
      setBusy(true);
      try {
        await submitAnswer(pending.id, { answers });
      } catch (err) {
        toast.error(`提交回答失败:${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    onAnswer?.(
      e.questions
        .map((q, i) =>
          e.questions.length > 1 ? `${q.header ?? q.question}:${answers[i]}` : answers[i],
        )
        .join("\n"),
    );
  };
  const decline = async () => {
    if (!pending || !submitAnswer) return;
    setBusy(true);
    try {
      await submitAnswer(pending.id, { decline: true });
    } catch (err) {
      toast.error(`提交失败:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const tone =
    state.kind === "pending"
      ? "text-warning-text"
      : state.kind === "answered"
        ? "text-success-text"
        : "text-muted-foreground";
  const StateIcon =
    state.kind === "pending"
      ? Clock
      : state.kind === "answered"
        ? Check
        : state.kind === "invalid"
          ? X
          : state.kind === "declined"
            ? Minus
            : Clock;

  return (
    <div
      data-testid="question-card"
      className={cn(
        "rounded-[14px] border p-3.5",
        pending
          ? "border-[#E7C78C] bg-card shadow-[0_0_0_3px_#FBF3E2]"
          : "border-border bg-[#F8F7F3]",
      )}
    >
      <div className={cn("flex flex-wrap items-center gap-1.5 text-[13px]", tone)}>
        {state.kind === "waiting" ? (
          <Spin className="size-3.5 border-[1.5px]" />
        ) : (
          <StateIcon className="size-3.5" />
        )}
        <span>
          <span data-testid="question-state" className="font-medium">
            {STATE_TEXT[state.kind]}
          </span>
          {pending ? (
            <span className="tabular-nums">
              ，剩余 {formatLeft(pending.expiresAt - now)}，超时后由智能体自行判断
            </span>
          ) : stateNote(state.kind) ? (
            <span>，{stateNote(state.kind)}</span>
          ) : null}
        </span>
      </div>
      {e.questions.map((q, qi) => (
        <div key={`${q.question}-${qi}`} className="mt-2">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            {q.question}
            {q.multiSelect && (
              <span className="rounded-full border border-border px-2 text-xs leading-5 font-normal text-muted-foreground">
                可多选
              </span>
            )}
          </p>
          {state.kind === "answered" ? (
            <p className="whitespace-pre-wrap break-words text-sm" data-testid="question-answer">
              <span className="text-muted-foreground">你的回答：</span>
              {state.answers[qi] ?? state.raw}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = (picked[qi] ?? new Set()).has(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={on}
                      disabled={!interactive || busy}
                      title={o.description}
                      onClick={() => toggle(qi, o.label, q.multiSelect === true)}
                      className={cn(
                        "min-h-[34px] rounded-[10px] border border-border bg-[#FBFAF7] px-3 py-1.5 text-left text-[13px] max-md:min-h-11 max-md:w-full max-md:text-[15px]",
                        interactive && !busy ? "hover:border-[#BDB8AC]" : "cursor-default",
                        on &&
                          "border-foreground bg-card shadow-[inset_0_0_0_1px_var(--foreground)]",
                      )}
                    >
                      {o.label}
                    </button>
                  );
                })}
                {interactive && (
                  <button
                    type="button"
                    aria-pressed={otherOpen[qi] === true}
                    disabled={busy}
                    onClick={() => toggleOther(qi, q.multiSelect === true)}
                    className={cn(
                      "min-h-[34px] rounded-[10px] border border-border bg-[#FBFAF7] px-3 py-1.5 text-left text-[13px] hover:border-[#BDB8AC] max-md:min-h-11 max-md:w-full max-md:text-[15px]",
                      otherOpen[qi] &&
                        "border-foreground bg-card shadow-[inset_0_0_0_1px_var(--foreground)]",
                    )}
                  >
                    其他（自己填写）
                  </button>
                )}
              </div>
              {interactive && otherOpen[qi] && (
                <input
                  type="text"
                  // biome-ignore lint/a11y/noAutofocus: 点了「其他」就是要马上输入
                  autoFocus
                  className="mt-2 h-[34px] w-full rounded-[10px] border border-border bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-[#9C978B] focus:ring-[3px] focus:ring-[#ECE9E1] max-md:h-11 max-md:text-base"
                  placeholder={q.multiSelect ? "写下你的补充" : "写下你的答案"}
                  aria-label={`其他回答:${q.question}`}
                  maxLength={2000}
                  disabled={busy}
                  value={other[qi] ?? ""}
                  onChange={(ev) => {
                    const text = ev.target.value;
                    setOther((o) => ({ ...o, [qi]: text }));
                  }}
                />
              )}
            </>
          )}
        </div>
      ))}
      {interactive && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={!complete || busy}
            className="max-md:h-11 max-md:flex-1"
          >
            {!complete ? "请先回答每个问题" : pending ? "提交回答" : "作为新消息发送"}
          </Button>
          {pending ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void decline()}
              className="max-md:h-11"
            >
              不回答
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">把你的选择当成一条新消息发出去</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 失败 / 结局未知 / 已取消 / 结构化结果 */
function ResultCard({ event }: { event: Extract<AgentEvent, { kind: "result" }> }) {
  if (event.status === "success") {
    const json = JSON.stringify(event.structured, null, 2);
    return (
      <div className="rounded-[14px] border border-[#D3E2D6] bg-[#F3F7F3] px-3.5 py-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-success-text">
          <Check className="size-4" strokeWidth={2} />
          结构化结果
          <button
            type="button"
            className="ml-auto inline-flex h-[30px] items-center gap-1 rounded-full px-2.5 text-[13px] font-normal text-[#4D4A43] hover:bg-[#E6EDE7]"
            onClick={() =>
              void navigator.clipboard.writeText(json).then(
                () => toast.success("已复制结构化结果"),
                () => toast.error("复制失败，请手动选择文本"),
              )
            }
          >
            <CopyIcon className="size-3.5" />
            复制 JSON
          </button>
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#1F1E1C] px-4 py-3 font-mono text-sm leading-[1.65] text-[#EAE6DC]">
          {json}
        </pre>
      </div>
    );
  }
  const look =
    event.status === "cancelled"
      ? {
          box: "border-border bg-[#F6F5F1]",
          title: "text-[#4D4A43]",
          text: "已取消",
          Icon: Square,
        }
      : event.status === "unknown"
        ? {
            box: "border-[#E7C78C] bg-[#FFF9EC]",
            title: "text-warning-text",
            text: "结局未知",
            Icon: AlertTriangle,
          }
        : {
            box: "border-[#EBC5BB] bg-[#FCF3F0]",
            title: "text-destructive",
            text: "这一轮失败了",
            Icon: AlertTriangle,
          };
  return (
    <div className={cn("rounded-[14px] border px-3.5 py-3", look.box)}>
      <div className={cn("flex items-center gap-1.5 text-sm font-semibold", look.title)}>
        <look.Icon className="size-4" />
        {look.text}
      </div>
      {event.summary && (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[#4A4740]">
          {event.summary}
        </p>
      )}
      {event.structured != null && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-[#F6F5F1] p-2.5 font-mono text-[13px]">
          {JSON.stringify(event.structured, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─────────────────────────── 单轮渲染（memo 化） ───────────────────────────

/** 把一个 activity 块拆成「思考」与「相邻工具调用」两类段落 */
type Segment =
  | { kind: "think"; text: string; subagent?: string }
  | { kind: "tools"; calls: ToolCall[] };

function segmentsOf(items: Extract<ProcessBlock, { kind: "activity" }>["items"]): Segment[] {
  const out: Segment[] = [];
  for (const item of items) {
    if (item.kind === "thinking") {
      out.push({ kind: "think", text: item.text, subagent: item.subagent });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "tools") last.calls.push(item.call);
    else out.push({ kind: "tools", calls: [item.call] });
  }
  return out;
}

const TurnView = memo(function TurnView({
  turn,
  turnIndex,
  turnKey,
  isLastTurn,
  openBlocks,
  onToggleBlock,
  onRerun,
  onAnswerAction,
  pendingQuestions,
  submitAnswer,
  agentId,
  agentIcon,
  agentName,
  onLocateToolAction,
  selectedToolLocator,
  readOnly,
  awaitingTools,
}: {
  awaitingTools?: readonly string[];
  turn: Turn;
  turnIndex: number;
  turnKey: string;
  isLastTurn: boolean;
  openBlocks: ReadonlyMap<string, boolean>;
  onToggleBlock(blockId: string, open: boolean): void;
  onRerun?: (turnIndex: number) => void;
  onAnswerAction?: (text: string) => void;
  pendingQuestions?: readonly PendingAsk[];
  submitAnswer?: SubmitAnswer;
  agentId: string;
  agentIcon?: string | null;
  agentName: string;
  onLocateToolAction?: (locator: string) => void;
  selectedToolLocator?: string | null;
  readOnly?: boolean;
}) {
  const { usage, blocks, questions, questionResults, questionAnswers, resultEvent, allText } =
    useMemo(() => {
      const folded = foldEvents(turn.events);
      // 提问的工具结果(回答 / 没回答)并进提问卡片显示,不再单独列成一块
      const questionIds = new Set(
        turn.events.flatMap((e) => (e.kind === "question" && e.toolUseId ? [e.toolUseId] : [])),
      );
      const results = new Map<string, { text: string; isError: boolean }>();
      const answersById = new Map<string, AnswerEvent>();
      for (const e of turn.events) {
        if (e.kind === "tool_result" && e.toolUseId && questionIds.has(e.toolUseId)) {
          results.set(e.toolUseId, { text: e.text, isError: e.isError === true });
        }
        if (e.kind === "answer" && e.toolUseId) answersById.set(e.toolUseId, e);
      }
      const items = folded.filter(
        (i) =>
          !(
            i.kind === "event" &&
            i.event.kind === "tool_result" &&
            i.event.toolUseId &&
            questionIds.has(i.event.toolUseId)
          ),
      );
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
        questionResults: results,
        questionAnswers: answersById,
        resultEvent: nextResultEvent,
        allText: nextBlocks
          .filter(
            (block): block is Extract<ProcessBlock, { kind: "text" }> => block.kind === "text",
          )
          .map((block) => block.text)
          .join(""),
      };
    }, [turn.events]);

  const { text: promptText, files } = useMemo(
    () => splitPromptAttachments(turn.prompt),
    [turn.prompt],
  );
  const lastBlock = blocks.at(-1);
  const waitingOnQuestion = questions.some((q) =>
    pendingQuestions?.some((p) => q.toolUseId && p.toolUseId === q.toolUseId),
  );
  const at = clock(turn.startedAt);
  const waitingTool = turn.running
    ? blocks
        .flatMap((b) => (b.kind === "activity" ? b.items : []))
        .find(
          (i): i is Extract<typeof i, { kind: "tool" }> =>
            i.kind === "tool" && !i.call.result && (awaitingTools?.includes(i.call.tool) ?? false),
        )?.call.tool
    : undefined;

  return (
    <div className="flex flex-col gap-2.5" data-turn={turnIndex + 1}>
      {turn.branchedFrom && (
        <p className="-mb-1 flex items-center gap-1.5 self-end text-[12.5px] text-muted-foreground">
          <GitBranch className="size-3.5" />
          从上文某轮分叉重跑
        </p>
      )}
      <div className="max-w-[78%] self-end whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] bg-[#E2E9E3] px-3.5 py-2 text-[14.5px] leading-[1.6] max-md:max-w-[88%] max-md:text-base">
        {promptText}
        {files.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {files.map((name) => (
              <span
                key={name}
                className="inline-flex h-[22px] items-center gap-1 rounded-full border border-border bg-white/70 px-2 text-xs text-muted-foreground"
              >
                <File className="size-3" />
                {name}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="flex items-start gap-2.5">
        <AgentAvatar id={agentId} icon={agentIcon} size={30} className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            {agentName}
            {at ? `，${at}` : ""}
          </div>

          {/* 过程按事件顺序渲染 */}
          {blocks.map((block, blockIndex) => {
            const blockId = `${turnKey}:${blockIndex}`;
            const isLatest = turn.running && block === lastBlock;
            if (block.kind === "activity") {
              const segs = segmentsOf(block.items);
              return segs.map((seg, si) => {
                const segId = `${blockId}:${si}`;
                if (seg.kind === "think") {
                  return (
                    <ThinkBlock
                      key={segId}
                      text={seg.text}
                      subagent={seg.subagent}
                      live={isLatest && si === segs.length - 1}
                    />
                  );
                }
                const live = turn.running && seg.calls.some((c) => !c.result);
                const open = openBlocks.get(segId) ?? live;
                return (
                  <ToolsCard
                    key={segId}
                    calls={seg.calls}
                    turnKey={turnKey}
                    running={turn.running}
                    open={open}
                    onToggle={() => onToggleBlock(segId, !open)}
                    onLocate={onLocateToolAction}
                    selected={selectedToolLocator}
                    awaiting={awaitingTools}
                  />
                );
              });
            }
            if (block.kind === "status") {
              return (
                <p
                  key={blockId}
                  className="flex items-center gap-2 text-[13px] text-muted-foreground"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-current opacity-50" />
                  {block.label}
                </p>
              );
            }
            if (block.kind === "steer") {
              const delivered = block.outcome === "delivered";
              return (
                <div
                  key={blockId}
                  className="max-w-[72%] self-end rounded-[14px_14px_4px_14px] border border-dashed border-[#C9C4B8] bg-[#FAF9F5] px-3.5 py-2 text-sm max-md:max-w-[88%]"
                >
                  <div
                    className={cn(
                      "mb-0.5 flex items-center gap-1.5 text-xs",
                      delivered ? "text-success-text" : "text-warning-text",
                    )}
                  >
                    {delivered ? <Check className="size-3.5" /> : <Clock className="size-3.5" />}
                    {delivered ? "运行中追加，已交给智能体" : "运行中追加，已改为本轮结束后发送"}
                  </div>
                  <span className="whitespace-pre-wrap break-words">{block.text}</span>
                </div>
              );
            }
            if (block.kind === "question") {
              const q = block.event;
              return (
                <QuestionBlock
                  key={blockId}
                  e={q}
                  state={questionState(
                    q,
                    q.toolUseId ? questionResults.get(q.toolUseId) : undefined,
                    pendingQuestions?.find((p) => q.toolUseId && p.toolUseId === q.toolUseId),
                    turn.running,
                    q.toolUseId ? questionAnswers.get(q.toolUseId) : undefined,
                  )}
                  canSendAsMessage={isLastTurn && !turn.running && !!onAnswerAction}
                  onAnswer={onAnswerAction}
                  submitAnswer={submitAnswer}
                />
              );
            }
            if (block.kind === "tool-result") {
              return (
                <pre
                  key={blockId}
                  className={cn(
                    "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#F6F5F1] p-2.5 font-mono text-[13px]",
                    block.isError ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {block.text.slice(0, 2000)}
                </pre>
              );
            }
            return (
              <div
                key={blockId}
                className="chat-md min-w-0 text-[14.5px] leading-[1.75] max-md:text-base"
              >
                <MessageResponse isAnimating={turn.running}>{block.text}</MessageResponse>
              </div>
            );
          })}

          {resultEvent && <ResultCard event={resultEvent} />}

          {turn.running && !waitingOnQuestion && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spin />
              {waitingTool ? (
                <span>等你确认 {waitingTool} 后继续</span>
              ) : (
                <span>
                  正在处理
                  {turn.startedAt && (
                    <>
                      ，已用 <WorkingTimer createdAt={turn.startedAt} />
                    </>
                  )}
                </span>
              )}
            </div>
          )}

          {!turn.running && (usage.input > 0 || usage.output > 0 || allText || turn.runId) && (
            <div className="flex flex-wrap items-center gap-1 text-[12.5px] text-muted-foreground">
              {(usage.input > 0 || usage.output > 0) && (
                <span className="mr-1.5 tabular-nums" title="这一轮的输入 / 输出 token">
                  ↑ {usage.input.toLocaleString()}　↓ {usage.output.toLocaleString()} token
                </span>
              )}
              {allText && (
                <button
                  type="button"
                  className="inline-flex h-[30px] items-center gap-1 rounded-full px-2.5 text-[13px] text-[#4D4A43] hover:bg-accent max-md:h-11"
                  onClick={() => {
                    void navigator.clipboard.writeText(allText).then(
                      () => toast.success("回复已复制"),
                      () => toast.error("复制失败，请手动选择文本"),
                    );
                  }}
                >
                  <CopyIcon className="size-3.5" />
                  复制
                </button>
              )}
              {turn.runId && onRerun && !readOnly && (
                <button
                  type="button"
                  className="inline-flex h-[30px] items-center gap-1 rounded-full px-2.5 text-[13px] text-[#4D4A43] hover:bg-accent max-md:h-11"
                  onClick={() => onRerun(turnIndex)}
                >
                  <RotateCcw className="size-3.5" />
                  重跑
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ─────────────────────────── 主组件 ───────────────────────────

export function scrollModeForDistance(distanceFromEnd: number): ScrollMode {
  if (distanceFromEnd <= 48) return "following";
  if (distanceFromEnd <= 320) return "anchoring";
  return "free";
}

/** 重跑弹窗:可以改写这一轮的消息,回到这一轮之前的状态重来。 */
function RerunDialog({
  target,
  laterTurns,
  onCancel,
  onConfirm,
}: {
  target: { index: number; runId: string; prompt: string } | null;
  laterTurns: number;
  onCancel(): void;
  onConfirm(runId: string, prompt: string): void;
}) {
  const [text, setText] = useState("");
  const files = useMemo(
    () => (target ? splitPromptAttachments(target.prompt).files : []),
    [target],
  );
  useEffect(() => {
    if (target) setText(splitPromptAttachments(target.prompt).text);
  }, [target]);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>重跑第 {(target?.index ?? 0) + 1} 轮</DialogTitle>
          <DialogDescription>
            回到这一轮之前的状态，用下面的内容重新跑：之前的对话保留，
            {laterTurns > 0 ? `这一轮及之后的 ${laterTurns + 1} 轮` : "这一轮"}
            不再算进上下文，已有记录原样保留。较早的记录定位不到那一轮之前的状态时，改用干净上下文重跑并提示你。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (target && text.trim())
              onConfirm(target.runId, joinPromptAttachments(text.trim(), files));
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-[13px] text-muted-foreground">这一轮的消息（可改写）</span>
            <textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full resize-y rounded-[10px] border border-border bg-card px-3 py-2.5 text-sm leading-[1.6] outline-none focus:border-[#9C978B] focus:ring-[3px] focus:ring-[#ECE9E1]"
            />
          </label>
          {files.length > 0 && (
            <p className="text-sm text-muted-foreground">
              这一轮的附件照样带上：{files.join("、")}
            </p>
          )}
          <p className="flex items-center gap-2 rounded-[10px] bg-[#F4F2EC] px-3 py-2 text-sm text-[#3C3A35]">
            <Coins className="size-4 shrink-0" />
            重跑会重新调用模型并计费
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={!text.trim()}>
              <RotateCcw />
              重跑
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChatThread({
  turns,
  onRerunAction,
  onAnswerAction,
  pendingQuestions,
  submitAnswerAction,
  agentName,
  agentId,
  agentIcon,
  onLocateToolAction,
  selectedToolLocator,
  readOnly,
  awaitingTools,
}: {
  turns: Turn[];
  onRerunAction?: (runId: string, prompt: string) => void;
  onAnswerAction?: (text: string) => void;
  /** 运行在等回答的提问(按 toolUseId 对到卡片上) */
  pendingQuestions?: readonly PendingAsk[];
  submitAnswerAction?: SubmitAnswer;
  /** 回答者的名字与头像;不传时按智能体设计器显示 */
  agentName?: string;
  agentId?: string;
  agentIcon?: string | null;
  /** 点工具调用:交给外面的执行详情面板定位(locator 见 toolLocator);不传则就地展开 */
  onLocateToolAction?: (locator: string) => void;
  selectedToolLocator?: string | null;
  /** 只读(已归档的会话):不给重跑 */
  readOnly?: boolean;
  /** 正在等你确认的工具名(对应的调用标「等你确认」) */
  awaitingTools?: readonly string[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollMode, setScrollMode] = useState<ScrollMode>("following");
  const [openBlocks, setOpenBlocks] = useState<Map<string, boolean>>(() => new Map());
  const [rerunIndex, setRerunIndex] = useState<number | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
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
    paddingEnd: 28,
    scrollPaddingEnd: 28,
    anchorTo: "end",
    followOnAppend: scrollMode === "following" && !anchorAppendedTurn ? "auto" : false,
    scrollEndThreshold: 48,
    getItemKey: (index) => {
      const turn = turns[index];
      return turn ? turnKeyOf(turn, index) : `turn-${index}`;
    },
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

  const onToggleBlock = useCallback((blockId: string, open: boolean) => {
    setOpenBlocks((current) => new Map(current).set(blockId, open));
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

  /** 轮次很多时导航条按步长取样,首尾一定在 */
  const railIndexes = useMemo(() => {
    if (turns.length <= 40) return turns.map((_, index) => index);
    const step = Math.ceil(turns.length / 40);
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
    // 导航条高亮「视口上部 40% 处」所在的那一轮
    const probe = element.scrollTop + element.clientHeight * 0.4;
    const hit = virtualizer
      .getVirtualItems()
      .find((item) => item.start <= probe && item.end > probe);
    if (hit) setCurrentTurn(hit.index);
  }, [virtualizer]);

  const enterFreeScrolling = useCallback(() => {
    setScrollMode((current) => transitionScrollMode(current, { kind: "user-navigation" }));
  }, []);

  const openRerun = useCallback((index: number) => setRerunIndex(index), []);

  if (turns.length === 0) return null;

  const virtualItems = virtualizer.getVirtualItems();
  const rerunTurn = rerunIndex !== null ? turns[rerunIndex] : undefined;
  const name = agentName ?? "智能体设计器";
  const avatarId = agentId ?? "agent-architect";

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
        className={cn(
          "h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 sm:pl-9",
          turns.length > 1 ? "sm:pr-16" : "sm:pr-9",
        )}
      >
        <div
          className="relative mx-auto w-full max-w-[780px]"
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
                className={cn(
                  "absolute left-0 top-0 w-full pt-[22px]",
                  virtualRow.index > 0 && "border-t border-dashed border-border",
                )}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <div className="pb-[18px]">
                  <TurnView
                    turn={turn}
                    turnIndex={virtualRow.index}
                    turnKey={turnKey}
                    isLastTurn={virtualRow.index === turns.length - 1}
                    openBlocks={openBlocks}
                    onToggleBlock={onToggleBlock}
                    onRerun={onRerunAction ? openRerun : undefined}
                    onAnswerAction={onAnswerAction}
                    pendingQuestions={pendingQuestions}
                    submitAnswer={submitAnswerAction}
                    agentId={avatarId}
                    agentIcon={agentIcon}
                    agentName={name}
                    onLocateToolAction={onLocateToolAction}
                    selectedToolLocator={selectedToolLocator}
                    readOnly={readOnly}
                    awaitingTools={awaitingTools}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {turns.length > 1 && (
        <nav
          aria-label="轮次导航"
          className="absolute top-1/2 right-3 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col gap-1 overflow-y-auto rounded-[14px] border border-border bg-card p-[5px] sm:flex"
        >
          {railIndexes.map((index) => {
            const turn = turns[index];
            if (!turn) return null;
            return (
              <button
                key={turnKeyOf(turn, index)}
                type="button"
                className={cn(
                  "h-[26px] w-7 shrink-0 rounded-lg text-xs text-muted-foreground tabular-nums hover:bg-[#F1EFE9] hover:text-foreground",
                  index === currentTurn &&
                    "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                )}
                title={`第 ${index + 1} 轮: ${turn.prompt.slice(0, 40)}`}
                aria-label={`跳到第 ${index + 1} 轮`}
                aria-current={index === currentTurn ? "true" : undefined}
                onClick={() => {
                  enterFreeScrolling();
                  setCurrentTurn(index);
                  virtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
                }}
              >
                {index + 1}
              </button>
            );
          })}
        </nav>
      )}

      {scrollMode !== "following" && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 z-20 flex h-[34px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-[13px] shadow-[0_6px_18px_rgb(40_35_25/12%)] hover:bg-[#F4F2EC]"
          aria-label="回到最新消息"
          onClick={() => scrollToEnd(true)}
        >
          <ArrowDown className="size-[15px]" />
          回到最新
        </button>
      )}

      <RerunDialog
        target={
          rerunTurn?.runId && rerunIndex !== null
            ? { index: rerunIndex, runId: rerunTurn.runId, prompt: rerunTurn.prompt }
            : null
        }
        laterTurns={rerunIndex !== null ? turns.length - 1 - rerunIndex : 0}
        onCancel={() => setRerunIndex(null)}
        onConfirm={(runId, prompt) => {
          setRerunIndex(null);
          onRerunAction?.(runId, prompt);
        }}
      />
    </div>
  );
}
