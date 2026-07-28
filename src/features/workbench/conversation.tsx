"use client";

import type { AgentEvent } from "@/lib/shared";
import { useState } from "react";
import type { Turn } from "./types";

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
    <div className="space-y-3 rounded-lg border border-blue-500/25 bg-blue-500/[0.04] p-3">
      <p className="text-xs opacity-55">助手在等你选择</p>
      {e.questions.map((q, qi) => (
        <div key={`${q.question}-${qi}`} className="space-y-2">
          <p className="font-medium text-sm">
            {q.question}
            {q.multiSelect && <span className="ml-2 text-xs opacity-50">(可多选)</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => {
              const on = (picked[qi] ?? new Set()).has(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  disabled={!answerable}
                  title={o.description}
                  onClick={() => toggle(qi, o.label, q.multiSelect === true)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? "border-blue-500 bg-blue-500 text-white"
                      : "border-black/15 hover:border-black/40 dark:border-white/25 dark:hover:border-white/60"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {/* 描述是 agent 写给用户的判断依据,不该只藏在 title 里 */}
          {q.options.some((o) => o.description) && (
            <ul className="space-y-0.5 text-xs opacity-45">
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
        <button
          type="button"
          onClick={submit}
          disabled={!complete}
          className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-35 dark:bg-white dark:text-black"
        >
          {complete ? "发送选择" : "请先选择"}
        </button>
      ) : (
        <p className="text-xs opacity-40">这是历史提问,已由后续对话回答</p>
      )}
    </div>
  );
}

function ToolBlock({ call }: { call: ToolCall }) {
  const arg = JSON.stringify(call.input);
  return (
    <details className="rounded border border-black/10 bg-black/[0.02] dark:border-white/15 dark:bg-white/5">
      <summary className="cursor-pointer px-2 py-1 font-mono text-xs">
        {call.subagent && <span className="mr-1 opacity-50">[{call.subagent}]</span>}
        <span className="font-medium">{call.tool}</span>
        <span className="ml-2 opacity-50">{arg.length > 90 ? `${arg.slice(0, 90)}…` : arg}</span>
        {call.result?.isError && <span className="ml-2 text-red-600">失败</span>}
      </summary>
      <div className="space-y-2 border-black/10 border-t px-2 py-2 dark:border-white/15">
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs opacity-70">
          {JSON.stringify(call.input, null, 2)}
        </pre>
        {call.result && (
          <pre
            className={`overflow-x-auto whitespace-pre-wrap font-mono text-xs ${
              call.result.isError ? "text-red-600" : "opacity-70"
            }`}
          >
            {call.result.text.slice(0, 2000)}
          </pre>
        )}
      </div>
    </details>
  );
}

function EventBlock({ e }: { e: AgentEvent }) {
  const tag = "subagent" in e && e.subagent ? `[${e.subagent}] ` : "";
  switch (e.kind) {
    case "text":
      return (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {tag}
          {e.text}
        </p>
      );
    case "thinking":
      return (
        <p className="whitespace-pre-wrap text-sm italic leading-relaxed opacity-45">
          {tag}
          {e.text}
        </p>
      );
    case "tool_result":
      return (
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs opacity-60">
          {e.text.slice(0, 800)}
        </pre>
      );
    case "status":
      return <p className="text-xs opacity-45">● {e.label}</p>;
    case "artifact":
      return <p className="font-mono text-xs">📦 {e.path}</p>;
    case "result":
      // 三态而非二态:unknown 是【结局未知】。把它渲染成红色"失败"和渲染成绿色"完成"
      // 一样是在骗人 —— 任务可能正跑得好好的,只是这条流看不到而已。
      return (
        <div
          className={`rounded px-2 py-1 text-sm ${
            e.status === "success"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : e.status === "unknown"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "bg-red-500/10 text-red-700 dark:text-red-400"
          }`}
        >
          <span className="font-medium">
            {e.status === "success" ? "✓ 完成" : e.status === "unknown" ? "⋯ 结局未知" : "✗ 失败"}
          </span>
          {e.summary && <span className="ml-2 opacity-80">{e.summary}</span>}
          {e.structured !== undefined && e.structured !== null && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
              {JSON.stringify(e.structured, null, 2)}
            </pre>
          )}
        </div>
      );
    default:
      return null;
  }
}

export function Conversation({
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
    return (
      <p className="pt-16 text-center text-sm opacity-40">
        发一句话试试,比如「在工作目录写一个 hello.py 并运行它」
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {turns.map((turn, i) => {
        const usage = sumUsage(turn.events);
        return (
          <section key={`${i}-${turn.prompt.slice(0, 20)}`} className="space-y-3">
            {turn.branchedFrom && <p className="text-xs opacity-45">⑂ 从上文某轮分叉重跑</p>}
            <div className="group flex items-start gap-2">
              <p className="flex-1 rounded-lg bg-black/5 px-3 py-2 text-sm dark:bg-white/10">
                {turn.prompt}
              </p>
              {turn.runId && onRerun && !turn.running && (
                <button
                  type="button"
                  className="shrink-0 pt-2 text-xs opacity-0 underline transition-opacity group-hover:opacity-60 hover:!opacity-100"
                  title="用干净上下文换个说法重跑,不影响已有记录"
                  onClick={() => {
                    const next = window.prompt("重跑这一轮(干净上下文),换个说法:", turn.prompt);
                    if (next?.trim() && turn.runId) onRerun(turn.runId, next.trim());
                  }}
                >
                  重跑
                </button>
              )}
            </div>
            <div className="space-y-2 pl-1">
              {foldEvents(turn.events).map((item, j) => {
                if (item.kind === "tool") {
                  return <ToolBlock key={`t-${j}-${item.tool}`} call={item} />;
                }
                if (item.event.kind === "question") {
                  return (
                    <QuestionBlock
                      // 【必须用稳定 key】QuestionBlock 自己持有选中状态,
                      // 纯下标作 key 时事件流一变动,React 会把 A 问题的选中态
                      // 复用到 B 问题上 —— 用户看着自己没点过的选项亮着。
                      // toolUseId 由 SDK 给,同一次提问全程不变。
                      key={item.event.toolUseId ?? `q-${item.event.questions[0]?.question}`}
                      e={item.event}
                      // 只有最新一轮、且已经跑完的提问才可点(见 QuestionBlock 注释)
                      answerable={i === turns.length - 1 && !turn.running && !!onAnswer}
                      onAnswer={onAnswer}
                    />
                  );
                }
                return <EventBlock key={`e-${j}-${item.event.kind}`} e={item.event} />;
              })}
              {turn.running && <p className="text-xs opacity-40">▍运行中…</p>}
              {(usage.input > 0 || usage.output > 0) && (
                <p className="text-xs opacity-35">
                  tokens ↑{usage.input} ↓{usage.output}
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
