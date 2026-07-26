"use client";

import type { AgentEvent } from "@/lib/shared";
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
 * 工具调用与结果在流里是分开的两条事件,按 toolUseId 合并后 UI 才读得懂。
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
      return (
        <div
          className={`rounded px-2 py-1 text-sm ${
            e.status === "success"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-red-500/10 text-red-700 dark:text-red-400"
          }`}
        >
          <span className="font-medium">{e.status === "success" ? "✓ 完成" : "✗ 失败"}</span>
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

export function Conversation({ turns }: { turns: Turn[] }) {
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
            <p className="rounded-lg bg-black/5 px-3 py-2 text-sm dark:bg-white/10">
              {turn.prompt}
            </p>
            <div className="space-y-2 pl-1">
              {foldEvents(turn.events).map((item, j) =>
                item.kind === "tool" ? (
                  <ToolBlock key={`t-${j}-${item.tool}`} call={item} />
                ) : (
                  <EventBlock key={`e-${j}-${item.event.kind}`} e={item.event} />
                ),
              )}
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
