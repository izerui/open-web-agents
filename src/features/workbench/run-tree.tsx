"use client";

import { cn } from "@/lib/utils";
import { Activity } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CallStateIcon, callStateOf } from "./chat-bits";
import { shortenPaths, summarizeToolInput, toolNameClass } from "./conversation";
import { type ToolCall, foldEvents, toolLocator, turnKeyOf } from "./conversation.logic";
import type { Turn } from "./types";

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 执行详情:当前会话每一轮调用了哪些工具、成没成,点一项看它的输入输出。
 *
 * 【为什么要有】对话流里工具调用只留一行汇总,要知道到底哪一步失败、传了什么参数,
 * 得在长对话里逐个展开。这里按轮列出全部调用,失败项标红,点开看输入输出。
 *
 * 【为什么没有耗时】事件流里没有每次调用的起止时间,编一个数字比不写更糟。
 *
 * 选中项可以由外面控制(对话流里点工具摘要 → 这里定位并高亮);不传时自己管。
 */
export function RunTree({
  turns,
  agentName,
  selected: selectedProp,
  onSelectAction,
  running = false,
}: {
  turns: Turn[];
  /** 主智能体的名字(详情里的「发起者」) */
  agentName?: string;
  selected?: string | null;
  onSelectAction?: (locator: string | null) => void;
  running?: boolean;
}) {
  const rounds = useMemo(
    () =>
      turns.map((turn, i) => {
        const key = turnKeyOf(turn, i);
        const calls = foldEvents(turn.events).filter((r): r is ToolCall => r.kind === "tool");
        return {
          key,
          index: i + 1,
          nodes: calls.map((call) => ({
            locator: toolLocator(key, call.key),
            call,
            state: callStateOf(call, turn.running),
          })),
        };
      }),
    [turns],
  );
  const [own, setOwn] = useState<string | null>(null);
  const selected = selectedProp !== undefined ? selectedProp : own;
  const select = (locator: string | null) => {
    if (onSelectAction) onSelectAction(locator);
    else setOwn(locator);
  };
  const listRef = useRef<HTMLDivElement>(null);

  // 被定位时滚到那一项,并闪一下
  useEffect(() => {
    if (!selected) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-locator="${CSS.escape(selected)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.animate([{ backgroundColor: "#FCE9B8" }, { backgroundColor: "transparent" }], {
      duration: 1600,
      easing: "ease-out",
    });
  }, [selected]);

  const all = rounds.flatMap((r) => r.nodes);
  const failed = all.filter((n) => n.state === "error").length;

  if (all.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-muted-foreground">
        <Activity className="mx-auto size-7" />
        <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">
          这个会话还没有调用过工具
        </p>
        <p>智能体调用工具、技能包、MCP 或子代理时，会按轮次列在这里。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-2.5 text-[12.5px] text-muted-foreground">
        <span>
          总计{" "}
          <b className="font-semibold text-foreground">
            {all.length} 次调用，{failed} 失败
          </b>
        </span>
        {running && (
          <span className="rounded-full bg-warning-soft px-2 text-xs leading-5 text-warning-text">
            运行中
          </span>
        )}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-4">
        <ul aria-label="工具调用">
          {rounds
            .filter((r) => r.nodes.length > 0)
            .map((r) => {
              const roundFailed = r.nodes.filter((n) => n.state === "error").length;
              return (
                <li key={r.key}>
                  <p className="flex items-center gap-2 px-1 pt-2.5 pb-1.5 text-[13px] font-semibold">
                    第 {r.index} 轮
                    <span className="font-normal text-muted-foreground">
                      {r.nodes.length} 次，{roundFailed} 失败
                    </span>
                  </p>
                  <ul>
                    {r.nodes.map((n) => {
                      const open = n.locator === selected;
                      return (
                        <li
                          key={n.locator}
                          data-locator={n.locator}
                          className={cn(
                            "mb-1.5 overflow-hidden rounded-[10px] border border-border",
                            n.state === "error" && "border-[#EBC5BB]",
                            open && "border-[#9C978B] shadow-[0_0_0_3px_#ECE9E1]",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => select(open ? null : n.locator)}
                            aria-expanded={open}
                            className="flex min-h-[38px] w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] hover:bg-[#FAF9F6]"
                          >
                            <CallStateIcon state={n.state} />
                            <span
                              className={cn(
                                "min-w-0 shrink-0 truncate font-mono text-[12.5px]",
                                n.state === "error"
                                  ? "text-destructive"
                                  : toolNameClass(n.call.tool),
                              )}
                            >
                              {n.call.tool}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {shortenPaths(summarizeToolInput(n.call.tool, n.call.input))}
                            </span>
                            {n.call.subagent && (
                              <span className="shrink-0 rounded-full border border-border px-1.5 text-xs leading-5 text-muted-foreground">
                                子代理
                              </span>
                            )}
                          </button>
                          {open && (
                            <section
                              aria-label="调用详情"
                              className="border-t border-line-soft px-3 pt-1 pb-3 text-[13px]"
                            >
                              <p className="mt-2.5 mb-1 text-xs text-muted-foreground">
                                {n.call.subagent ? "由哪个子代理发起" : "发起者"}
                              </p>
                              <p>
                                {n.call.subagent
                                  ? `子代理 ${n.call.subagent}`
                                  : `${agentName ?? "智能体"}（主智能体）`}
                              </p>
                              <p className="mt-2.5 mb-1 text-xs text-muted-foreground">输入</p>
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px]">
                                {pretty(n.call.input)}
                              </pre>
                              <p className="mt-2.5 mb-1 text-xs text-muted-foreground">输出</p>
                              <pre
                                className={cn(
                                  "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px]",
                                  n.call.result?.isError && "text-destructive",
                                )}
                              >
                                {n.call.result
                                  ? n.call.result.text || "（空）"
                                  : n.state === "running"
                                    ? "运行中…"
                                    : "没有收到结果"}
                              </pre>
                            </section>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}
