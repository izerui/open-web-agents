"use client";

import { cn } from "@/lib/utils";
import { Check, ChevronDown, ChevronRight, Circle, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { summarizeToolInput, toolNameClass } from "./conversation";
import { type ToolCall, foldEvents } from "./conversation.logic";
import type { Turn } from "./types";

type Node = { key: string; call: ToolCall; state: "ok" | "error" | "running" | "unknown" };

function stateOf(call: ToolCall, turnRunning: boolean): Node["state"] {
  if (call.result) return call.result.isError ? "error" : "ok";
  // 没有结果:这一轮还在跑就是进行中;已经结束还没结果,说明结果没回传(中断、超时)
  return turnRunning ? "running" : "unknown";
}

function StateIcon({ state }: { state: Node["state"] }) {
  if (state === "ok") return <Check className="size-3.5 text-success" />;
  if (state === "error") return <X className="size-3.5 text-destructive" />;
  if (state === "running") return <Loader2 className="size-3.5 animate-spin text-info" />;
  return <Circle className="size-3 text-muted-foreground" />;
}

/** 绝对路径在 300px 宽的窗口里只能看到开头,而有用的是结尾的文件名:只留最后两段。 */
function shortArg(text: string): string {
  return text.replace(/(?:\/[^\s/]+){3,}\/([^\s/]+\/[^\s/]+)/g, "…/$1");
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 运行树:当前会话每一轮调用了哪些工具、成没成,点一项看它的输入输出。
 *
 * 【为什么要有】对话流里工具调用只留一行摘要("Ran 13 tools · 1 failed"),
 * 要知道到底哪一步失败、传了什么参数,得在长对话里逐个展开。智能体运行本质上是
 * 一串调用,IDE 的 Run 窗口把它画成一棵树、失败项标红、点开看输出 —— 这里照做。
 *
 * 【为什么没有耗时】事件流里没有每次调用的起止时间,编一个数字比不写更糟。
 * 子智能体的调用缩进一级,标出是哪个子智能体发起的。
 */
export function RunTree({ turns }: { turns: Turn[] }) {
  const rounds = useMemo(
    () =>
      turns.map((turn, i) => {
        const calls = foldEvents(turn.events).filter((r): r is ToolCall => r.kind === "tool");
        const nodes: Node[] = calls.map((call, j) => ({
          key: `${turn.localId ?? turn.runId ?? i}:${j}`,
          call,
          state: stateOf(call, turn.running),
        }));
        return {
          key: turn.localId ?? turn.runId ?? String(i),
          index: i + 1,
          prompt: turn.prompt,
          nodes,
        };
      }),
    [turns],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const all = rounds.flatMap((r) => r.nodes);
  const failed = all.filter((n) => n.state === "error").length;
  const current = all.find((n) => n.key === selected) ?? null;

  if (all.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-xs text-muted-foreground">
        这个会话还没有调用过工具
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs" aria-label="工具调用">
        {rounds
          .filter((r) => r.nodes.length > 0)
          .map((r) => {
            const open = !collapsed.has(r.key);
            const roundFailed = r.nodes.filter((n) => n.state === "error").length;
            return (
              <li key={r.key}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((s) => {
                      const next = new Set(s);
                      if (next.has(r.key)) next.delete(r.key);
                      else next.add(r.key);
                      return next;
                    })
                  }
                  className="flex h-7 w-full items-center gap-1.5 px-2 text-left font-sans text-sm hover:bg-accent"
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="shrink-0 font-medium">第 {r.index} 轮</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.prompt}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.nodes.length} 次
                    {roundFailed > 0 && (
                      <span className="text-destructive"> · {roundFailed} 失败</span>
                    )}
                  </span>
                </button>
                {open && (
                  <ul>
                    {r.nodes.map((n) => (
                      <li key={n.key}>
                        <button
                          type="button"
                          onClick={() => setSelected(n.key === selected ? null : n.key)}
                          aria-pressed={n.key === selected}
                          className={cn(
                            "flex h-7 w-full items-center gap-2 pr-2 text-left",
                            n.key === selected ? "bg-sidebar-active" : "hover:bg-accent",
                          )}
                          style={{ paddingLeft: n.call.subagent ? 44 : 28 }}
                        >
                          <StateIcon state={n.state} />
                          <span
                            className={cn(
                              "shrink-0",
                              n.state === "error" ? "text-destructive" : toolNameClass(n.call.tool),
                            )}
                          >
                            {n.call.tool}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {shortArg(summarizeToolInput(n.call.tool, n.call.input))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
      </ul>

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {all.length} 次调用
        {failed > 0 && <span className="text-destructive"> · {failed} 失败</span>}
      </div>

      {current && (
        <section
          aria-label="调用详情"
          className="max-h-[45%] min-h-32 shrink-0 overflow-y-auto border-t border-border bg-background px-3 py-2 font-mono text-xs"
        >
          <p className="mb-2 flex items-center gap-2 font-sans text-sm">
            <StateIcon state={current.state} />
            <span className="font-medium">{current.call.tool}</span>
            {current.call.subagent && (
              <span className="text-xs text-muted-foreground">由 {current.call.subagent} 发起</span>
            )}
          </p>
          <p className="mb-1 font-sans text-muted-foreground">输入</p>
          <pre className="mb-3 whitespace-pre-wrap break-all">{pretty(current.call.input)}</pre>
          <p className="mb-1 font-sans text-muted-foreground">输出</p>
          <pre
            className={cn(
              "whitespace-pre-wrap break-all",
              current.call.result?.isError && "text-destructive",
            )}
          >
            {current.call.result
              ? current.call.result.text || "(空)"
              : current.state === "running"
                ? "运行中…"
                : "没有收到结果"}
          </pre>
        </section>
      )}
    </div>
  );
}
