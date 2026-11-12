"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Archive, ArrowLeft, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Spin } from "./chat-bits";
import {
  chatBuckets,
  designSessionHref,
  filterSessions,
  rowTime,
  sessionWaitOf,
} from "./chat-view.logic";
import { SessionActions } from "./session-actions";
import { activityOf, sessionLabel } from "./session-groups";
import type { AgentSummary, SessionSummary } from "./types";

export type ListView = "active" | "archived";

/** 当前打开的会话在等什么(列表里标「待你确认 / 等你回答」) */
export type SessionWait = "approval" | "ask" | null;

/**
 * 对话页左栏:搜索、新会话、按今天 / 昨天 / 更早分组的会话,底部切到「已归档」可恢复。
 * 智能体设计器的会话标「设计器」,点开去构建页。
 */
export function SessionList({
  view,
  onViewChangeAction,
  query,
  onQueryChangeAction,
  sessions,
  archived,
  agents,
  loaded,
  error,
  onRetryAction,
  activeSessionId,
  running,
  wait,
  onOpenAction,
  onNewAction,
  onChangedAction,
  onRemovedAction,
  onRestoreAction,
  draft,
}: {
  /** 还没发消息的新会话(只在本地):列表顶上显示「新会话，刚刚」 */
  draft?: { agentId: string; agentName: string; icon?: string } | null;
  view: ListView;
  onViewChangeAction: (view: ListView) => void;
  query: string;
  onQueryChangeAction: (query: string) => void;
  sessions: SessionSummary[];
  archived: SessionSummary[];
  agents: AgentSummary[];
  loaded: boolean;
  error: string | null;
  onRetryAction: () => void;
  activeSessionId: string | null;
  /** 当前打开的会话正在运行 */
  running: boolean;
  wait: SessionWait;
  onOpenAction: (id: string) => void;
  onNewAction: () => void;
  onChangedAction: () => void;
  onRemovedAction: (id: string) => void;
  onRestoreAction: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const source = view === "archived" ? archived : sessions;
  const visible = useMemo(() => filterSessions(source, names, query), [source, names, query]);
  const groups = useMemo(() => chatBuckets(visible), [visible]);
  const q = query.trim();

  const row = (s: SessionSummary) => {
    const on = s.id === activeSessionId;
    const design = s.source === "design";
    const busy = (on && running) || (s.activeRuns ?? 0) > 0;
    // 没打开的会话也标:列表接口带回了运行中会话的待确认 / 待回答计数
    const waiting = sessionWaitOf(s, { id: activeSessionId, running, wait });
    const agent = byId.get(s.agentId);
    const agentName = design ? "智能体设计器" : (agent?.name ?? s.agentId);
    const meta = (
      <>
        <span className="block truncate text-sm leading-[1.35]">{sessionLabel(s)}</span>
        <span className="flex items-center gap-1.5 overflow-hidden text-xs leading-[1.4] whitespace-nowrap text-muted-foreground">
          {busy && <Spin className="size-3.5 border-[1.5px]" />}
          {waiting && (
            <span className="shrink-0 rounded-full bg-warning-soft px-1.5 leading-[18px] text-warning-text">
              {waiting === "approval" ? "待你确认" : "等你回答"}
            </span>
          )}
          {design && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-1.5 leading-[18px] text-primary-foreground">
              <Sparkles className="size-3" />
              设计器
            </span>
          )}
          <span className="truncate">
            {agentName}，{rowTime(activityOf(s))}
          </span>
        </span>
      </>
    );
    const rowClass = cn(
      "group relative flex min-h-[46px] items-center gap-2 rounded-xl border border-transparent py-2 pr-2 pl-2.5 hover:bg-[#EFEDE7]",
      on && "border-border bg-card shadow-[0_1px_3px_rgb(0_0_0/4%)] hover:bg-card",
    );
    const avatar = (
      <AgentAvatar
        id={design ? "agent-architect" : s.agentId}
        icon={design ? null : agent?.icon}
        size={26}
        className="shrink-0"
      />
    );
    return (
      <li key={s.id} className={rowClass}>
        {design && view === "active" ? (
          <Link
            href={designSessionHref(s)}
            title="智能体设计器的会话，在构建页里打开"
            className="flex min-w-0 flex-1 items-center gap-2 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-[#D9D5CB]"
          >
            {avatar}
            <span className="min-w-0 flex-1">{meta}</span>
          </Link>
        ) : (
          <a
            href={`/chat?session=${encodeURIComponent(s.id)}`}
            aria-current={on ? "page" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onOpenAction(s.id);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-[#D9D5CB]"
          >
            {avatar}
            <span className="min-w-0 flex-1">{meta}</span>
          </a>
        )}
        <span className="relative z-10 shrink-0">
          {view === "archived" ? (
            <Button
              variant="ghost"
              size="sm"
              className="max-md:h-11"
              onClick={() => onRestoreAction(s.id)}
            >
              恢复
            </Button>
          ) : (
            <SessionActions
              session={s}
              running={busy}
              onChanged={onChangedAction}
              onRemoved={onRemovedAction}
              className={cn(
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100",
                on && "opacity-100",
              )}
            />
          )}
        </span>
      </li>
    );
  };

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="px-3.5 py-7 text-center text-sm">
        <p className="text-destructive">会话列表加载失败：{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetryAction}>
          <RefreshCw />
          重试
        </Button>
      </div>
    );
  } else if (!loaded) {
    body = (
      <p className="flex items-center justify-center gap-2 px-3.5 py-7 text-sm text-muted-foreground">
        <Spin />
        正在读取会话…
      </p>
    );
  } else if (view === "archived") {
    body = (
      <>
        <p className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
          已归档（{archived.length}），恢复后回到会话列表
        </p>
        {visible.length > 0 ? (
          <ul className="space-y-0.5">{visible.map(row)}</ul>
        ) : (
          <p className="px-3.5 py-7 text-center text-sm text-muted-foreground">
            {q ? `没有匹配「${q}」的归档会话` : "没有归档的会话"}
          </p>
        )}
      </>
    );
  } else if (groups.length === 0 && !(draft && !q)) {
    body = (
      <p className="px-3.5 py-7 text-center text-sm text-muted-foreground">
        {q ? `没有匹配「${q}」的会话` : "还没有会话"}
      </p>
    );
  } else {
    // 新会话还没发消息时也在「今天」顶上占一行,让人知道自己正在哪
    const draftRow =
      draft && !q ? (
        <li
          key="draft"
          aria-current="page"
          className="relative flex min-h-[46px] items-center gap-2 rounded-xl border border-border bg-card py-2 pr-2 pl-2.5 shadow-[0_1px_3px_rgb(0_0_0/4%)]"
        >
          <AgentAvatar id={draft.agentId} icon={draft.icon} size={26} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm leading-[1.35]">新会话</span>
            <span className="block truncate text-xs leading-[1.4] text-muted-foreground">
              {draft.agentName}，刚刚
            </span>
          </span>
        </li>
      ) : null;
    const hasToday = groups.some((g) => g.bucket === "今天");
    body = (
      <>
        {draftRow && !hasToday && (
          <section aria-label="今天">
            <h2 className="px-3 pt-3 pb-1 text-xs font-normal text-muted-foreground">今天</h2>
            <ul className="space-y-0.5">{draftRow}</ul>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.bucket} aria-label={g.bucket}>
            <h2 className="px-3 pt-3 pb-1 text-xs font-normal text-muted-foreground">{g.bucket}</h2>
            <ul className="space-y-0.5">
              {g.bucket === "今天" && draftRow}
              {g.sessions.map(row)}
            </ul>
          </section>
        ))}
      </>
    );
  }

  return (
    <nav aria-label="会话列表" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 px-3 pt-3.5 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChangeAction(e.target.value)}
            placeholder={view === "archived" ? "搜索已归档" : "搜索会话"}
            aria-label={view === "archived" ? "搜索已归档" : "搜索会话"}
            className="h-9 w-full rounded-[10px] border border-border bg-card pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-[#9C978B] focus:ring-[3px] focus:ring-[#ECE9E1] max-md:h-11 max-md:text-base"
          />
        </div>
        <Button size="sm" onClick={onNewAction} className="max-md:h-11">
          <Plus strokeWidth={2} />
          新会话
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">{body}</div>
      <div className="border-t border-border px-3 pt-2.5 pb-3">
        <button
          type="button"
          onClick={() => onViewChangeAction(view === "archived" ? "active" : "archived")}
          className="flex h-9 w-full items-center gap-1.5 rounded-full px-2.5 text-[13px] text-[#4D4A43] hover:bg-[#EFEDE7] max-md:h-11"
        >
          {view === "archived" ? (
            <>
              <ArrowLeft className="size-[15px]" />
              返回会话列表
            </>
          ) : (
            <>
              <Archive className="size-[15px]" />
              已归档（{archived.length}）
            </>
          )}
        </button>
      </div>
    </nav>
  );
}
