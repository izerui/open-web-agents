"use client";

import type { AgentEvent } from "@/lib/shared";
import { useState } from "react";
import type { Turn } from "./types";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  RotateCcw,
  Check,
  X,
  AlertTriangle,
  HelpCircle,
  CopyIcon,
} from "lucide-react";

import {
  Message,
  MessageBranch,
  MessageBranchContent,
  MessageContent,
  MessageActions,
  MessageAction,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";

/** 把 tool_use 与其 tool_result 配对,渲染成一条可折叠的工具调用。 */
interface ToolCall {
  kind: "tool";
  tool: string;
  input: unknown;
  result?: { text: string; isError: boolean };
  subagent?: string;
}
type Rendered = ToolCall | { kind: "event"; event: AgentEvent };

/**
 * 事件流 → 渲染项。
 * - 工具调用与结果在流里是分开的两条事件,按 toolUseId 合并后 UI 才读得懂。
 * - 流式输出下同一段文本/思考会拆成大量小增量事件(逐 token),
 *   连续的同类(text/thinking)且同 subagent 的事件合并成一条,
 *   否则每个 token 变成一个独立的 <p> 标签。
 */
export function foldEvents(events: AgentEvent[]): Rendered[] {
  const out: Rendered[] = [];
  const byToolId = new Map<string, ToolCall>();

  for (const e of events) {
    if (e.kind === "tool_use") {
      const call: ToolCall = {
        kind: "tool",
        tool: e.tool,
        input: e.input,
        subagent: e.subagent,
      };
      if (e.toolUseId) byToolId.set(e.toolUseId, call);
      out.push(call);
    } else if (e.kind === "tool_result") {
      const call = e.toolUseId ? byToolId.get(e.toolUseId) : undefined;
      if (call) call.result = { text: e.text, isError: e.isError === true };
      else out.push({ kind: "event", event: e });
    } else if (e.kind === "usage") {
      // 用量在页脚汇总,不逐条打断阅读
    } else if (e.kind === "text" || e.kind === "thinking") {
      // 流式合并:连续的同类 + 同 subagent 事件拼成一条,而不是每个 token 一个 <p>
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.kind === "event" &&
        prev.event.kind === e.kind &&
        "subagent" in prev.event &&
        prev.event.subagent === e.subagent
      ) {
        // 就地合并文本(prev.event 是引用,直接修改即可)
        (prev.event as { text: string }).text += e.text;
      } else {
        // 新起一段:浅拷贝一份,后续合并修改拷贝而不是原始事件
        out.push({ kind: "event", event: { ...e } });
      }
    } else {
      out.push({ kind: "event", event: e });
    }
  }
  if (typeof window !== "undefined") { const tc = out.filter(x => x.kind === "event" && x.event.kind === "text").length; if (tc > 1) console.warn("[fold] text items:", tc, "events:", events.length); }
  return out;
}

/** 按 messageId 去重后求和 —— 流式下同一条消息会多次上报用量。 */
export function sumUsage(events: AgentEvent[]): { input: number; output: number } {
  const latest = new Map<string, { input: number; output: number }>();
  let anonInput = 0;
  let anonOutput = 0;
  for (const e of events) {
    if (e.kind !== "usage") continue;
    if (e.messageId) latest.set(e.messageId, { input: e.input, output: e.output });
    else {
      anonInput += e.input;
      anonOutput += e.output;
    }
  }
  let input = anonInput;
  let output = anonOutput;
  for (const u of latest.values()) {
    input += u.input;
    output += u.output;
  }
  return { input, output };
}

type QuestionEvent = Extract<AgentEvent, { kind: "question" }>;

/**
 * agent 的提问 —— 渲染成可点的选项,而不是一坨 JSON。
 *
 * 【为什么点了要作为下一轮发出去】SDK 的 canUseTool / PreToolUse 都只能放行或拒绝,
 * 给不了工具结果,没法在同一轮里把答案塞回去(见 shared/types.ts)。
 * 所以这里把选择拼成一句话作为新一轮的输入 —— agent 侧看到的是一次正常的多轮对话。
 *
 * 【为什么只有最新一轮可点】历史轮次的提问早就被后续对话回答过了,
 * 再摆着可点的按钮会让人以为还能改,点下去却是凭空多发一轮。
 */
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
        // 单选:点同一个再点一次可以取消,免得选错了没法回头
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
    // 多问一起答时带上标题,agent 才分得清哪个答案对哪个问题
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
          助手在等你选择
        </p>
        {e.questions.map((q, qi) => (
          <div key={`${q.question}-${qi}`} className="space-y-2">
            <p className="font-medium text-sm">
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
            {/* 描述是 agent 写给用户的判断依据,不该只藏在 title 里 */}
            {q.options.some((o) => o.description) && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {q.options
                  .filter((o) => o.description)
                  .map((o) => (
                    <li key={`d-${o.label}`}>
                      {o.label} —— {o.description}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        ))}
        {answerable ? (
          <Button type="button" onClick={submit} disabled={!complete} size="sm">
            {complete ? "发送选择" : "请先选择"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">这是历史提问,已由后续对话回答</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── 工具状态映射 ───────────────────────────

/** 把我们的 ToolCall 映射到 ai-elements ToolHeader 的 state */
function getToolState(call: ToolCall): "input-available" | "output-available" | "output-error" {
  if (!call.result) return "input-available";
  if (call.result.isError) return "output-error";
  return "output-available";
}

// ─────────────────────────── 辅助:收集思考文本 ───────────────────────────

/** 从渲染项中提取所有 thinking 事件的文本,合并为一段。 */
function collectThinkingText(items: Rendered[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "event" && item.event.kind === "thinking") {
      const tag =
        "subagent" in item.event && item.event.subagent
          ? `[${item.event.subagent}] `
          : "";
      parts.push(`${tag}${item.event.text}`);
    }
  }
  return parts.join("");
}

/** 从渲染项中提取所有助手文本内容(用于复制)。 */
function collectAllTextContent(items: Rendered[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "event" && item.event.kind === "text") {
      parts.push(item.event.text);
    }
  }
  return parts.join("");
}

// ─────────────────────────── 单条渲染项(不含 thinking) ───────────────────────────

function renderItem(item: Rendered, turn: Turn, itemIndex: number): React.ReactNode {
  if (item.kind === "tool") {
    const state = getToolState(item);
    const title = item.subagent ? `[${item.subagent}] ${item.tool}` : undefined;
    return (
      <Tool key={`t-${itemIndex}-${item.tool}`}>
        <ToolHeader
          type={`tool-${item.tool}` as any}
          state={state}
          title={title}
        />
        <ToolContent>
          <ToolInput input={item.input} />
          {item.result && (
            <ToolOutput
              output={
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                  {item.result.text.slice(0, 2000)}
                </pre>
              }
              errorText={item.result.isError ? item.result.text : undefined}
            />
          )}
        </ToolContent>
      </Tool>
    );
  }

  const e = item.event;
  const tag = "subagent" in e && e.subagent ? `[${e.subagent}] ` : "";

  switch (e.kind) {
    case "text":
      // text 已在上层合并为单个 MessageResponse 渲染,跳过单条
      return null;

    case "thinking":
      // thinking 已经在上层合并渲染,跳过单条
      return null;

    case "tool_result":
      // 未配对的孤儿 tool_result(极少出现)
      return (
        <pre
          key={`e-${itemIndex}-tool_result`}
          className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground"
        >
          {e.text.slice(0, 800)}
        </pre>
      );

    case "status":
      return (
        <p key={`e-${itemIndex}-status`} className="text-xs text-muted-foreground">
          ● {e.label}
        </p>
      );

    case "artifact":
      return (
        <p key={`e-${itemIndex}-artifact`} className="font-mono text-xs">
          📦 {e.path}
        </p>
      );

    case "result":
      // 成功且无结构化输出 → 不渲染任何东西。
      // chatbot 场景下文字流完就完了,不需要显式的"完成"标记;
      // 只有失败/未知/带结构化输出时才需要卡片。
      if (e.status === "success" && (e.structured === undefined || e.structured === null)) {
        return null;
      }
      return (
        <Card key={`e-${itemIndex}-result`} className="overflow-hidden">
          <CardContent className="flex items-start gap-2 p-2 text-sm">
            <Badge
              variant={
                e.status === "success"
                  ? "success"
                  : e.status === "unknown"
                    ? "warning"
                    : "destructive"
              }
            >
              {e.status === "success" ? (
                <>
                  <Check className="mr-1 inline-block h-3 w-3" /> 完成
                </>
              ) : e.status === "unknown" ? (
                <>
                  <AlertTriangle className="mr-1 inline-block h-3 w-3" /> 结局未知
                </>
              ) : (
                <>
                  <X className="mr-1 inline-block h-3 w-3" /> 失败
                </>
              )}
            </Badge>
            {e.summary && e.status !== "success" && <span className="opacity-80">{e.summary}</span>}
          </CardContent>
          {e.structured !== undefined && e.structured !== null && (
            <CardContent className="p-2 pt-0">
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                {JSON.stringify(e.structured, null, 2)}
              </pre>
            </CardContent>
          )}
        </Card>
      );

    case "question":
      // question 由外层单独处理(需要 answerable / onAnswer)
      // 这条路径不应被走到,但兜底返回 null
      return null;

    default:
      return null;
  }
}

// ─────────────────────────── 主组件 ───────────────────────────

export function ChatThread({
  turns,
  onRerun,
  onAnswer,
}: {
  turns: Turn[];
  onRerun?: (runId: string, prompt: string) => void;
  /** 用户点了 agent 提问里的选项 —— 作为新一轮发出去。 */
  onAnswer?: (text: string) => void;
}) {
  if (turns.length === 0) {
    return null; // empty state handled by parent (ConversationEmptyState)
  }

  return (
    <div className="space-y-6">
      {turns.map((turn, i) => {
        const items = foldEvents(turn.events);
        const usage = sumUsage(turn.events);
        const thinkingText = collectThinkingText(items);
        const allTextContent = collectAllTextContent(items);

        return (
          <div key={`${i}-${turn.prompt.slice(0, 20)}`} className="space-y-4">
            {/* 分叉标记 */}
            {turn.branchedFrom && (
              <p className="text-xs text-muted-foreground">⑂ 从上文某轮分叉重跑</p>
            )}

            {/* ── 用户消息 ── */}
            <MessageBranch defaultBranch={0}>
              <MessageBranchContent>
                <Message from="user">
                  <MessageContent>
                    <div className="text-sm">{turn.prompt}</div>
                  </MessageContent>
                </Message>
              </MessageBranchContent>
            </MessageBranch>

            {/* ── 助手消息 ── */}
            <MessageBranch defaultBranch={0}>
              <MessageBranchContent>
                <Message from="assistant">
                  <MessageContent>
                    {/* 合并后的思考块 —— 放在助手消息最前面 */}
                    {thinkingText && (
                      <Reasoning isStreaming={turn.running}>
                        <ReasoningTrigger />
                        <ReasoningContent>{thinkingText}</ReasoningContent>
                      </Reasoning>
                    )}

                    {/* 合并后的文本 —— 所有 text 事件拼成一个 MessageResponse */}
                    {allTextContent && (
                      <MessageResponse isAnimating={turn.running}>
                        {allTextContent}
                      </MessageResponse>
                    )}

                    {/* 其余渲染项(thinking 和 text 已在上方合并渲染,renderItem 中跳过) */}
                    {items.map((item, j) => {
                      // question 需要特殊处理(answerable / onAnswer)
                      if (item.kind === "event" && item.event.kind === "question") {
                        return (
                          <QuestionBlock
                            key={item.event.toolUseId ?? `q-${item.event.questions[0]?.question}`}
                            e={item.event}
                            answerable={i === turns.length - 1 && !turn.running && !!onAnswer}
                            onAnswer={onAnswer}
                          />
                        );
                      }
                      return renderItem(item, turn, j);
                    })}
                    {turn.running && (
                      <p className="text-xs text-muted-foreground">
                        <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                        运行中…
                      </p>
                    )}
                  </MessageContent>

                  {/* 操作按钮 */}
                  {!turn.running && (
                    <MessageActions>
                      {/* 复制回复内容 */}
                      {allTextContent && (
                        <MessageAction
                          label="复制"
                          tooltip="复制回复内容"
                          onClick={() => navigator.clipboard.writeText(allTextContent)}
                        >
                          <CopyIcon className="size-3" />
                        </MessageAction>
                      )}
                      {/* 重跑操作 */}
                      {turn.runId && onRerun && (
                        <MessageAction
                          label="重跑"
                          tooltip="用干净上下文换个说法重跑,不影响已有记录"
                          onClick={() => {
                            const next = window.prompt(
                              "重跑这一轮(干净上下文),换个说法:",
                              turn.prompt,
                            );
                            if (next?.trim() && turn.runId) onRerun(turn.runId, next.trim());
                          }}
                        >
                          <RotateCcw className="size-3" />
                        </MessageAction>
                      )}
                    </MessageActions>
                  )}
                </Message>
              </MessageBranchContent>
            </MessageBranch>

            {/* ── 用量页脚 ── */}
            {(usage.input > 0 || usage.output > 0) && (
              <Badge variant="secondary" className="font-normal">
                tokens ↑{usage.input} ↓{usage.output}
              </Badge>
            )}
          </div>
        );
      })}
    </div>
  );
}
