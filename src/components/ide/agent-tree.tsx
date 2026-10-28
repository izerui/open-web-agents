"use client";

import { activityOf, sessionLabel } from "@/features/workbench/session-groups";
import type { AgentSummary, SessionSummary } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { Bot, ChevronDown, ChevronRight, MessageSquare, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_CATALOG_CHANGED } from "./agent-catalog";
import type { AgentObject } from "./agent-workspace-header";

type Props = {
  activeAgentId?: string;
  activeSessionId?: string | null;
  tab?: AgentObject["tab"];
  agents?: AgentSummary[];
  sessions?: SessionSummary[];
  onPickAgentAction?: (id: string) => void;
  onOpenSessionAction?: (id: string) => void;
  onNewSessionAction?: () => void;
  sessionActions?: (session: SessionSummary) => React.ReactNode;
  running?: boolean;
};

/** 所有对象页面使用同一棵树;工作台复用其已加载的数据和挂流操作。 */
export function AgentTree(props: Props) {
  const [index, setIndex] = useState<{ agents: AgentSummary[]; sessions: SessionSummary[] }>({
    agents: [],
    sessions: [],
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(props.agents === undefined);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(props.activeAgentId);
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const [a, s] = await Promise.all([
        fetchJson<{ agents: AgentSummary[] }>("/api/agents"),
        fetchJson<{ sessions: SessionSummary[] }>("/api/sessions"),
      ]);
      if (seq === loadSeq.current) {
        setIndex({ agents: a.agents ?? [], sessions: s.sessions ?? [] });
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (props.agents !== undefined) return;
    const refresh = () => void load();
    refresh();
    window.addEventListener(AGENT_CATALOG_CHANGED, refresh);
    return () => {
      loadSeq.current += 1;
      window.removeEventListener(AGENT_CATALOG_CHANGED, refresh);
    };
  }, [props.agents, load]);
  useEffect(() => setExpanded(props.activeAgentId), [props.activeAgentId]);
  const agents = props.agents ?? index.agents;
  const sessions = props.sessions ?? index.sessions;
  const needle = query.trim().toLocaleLowerCase();
  const visible = agents.filter(
    (agent) =>
      !needle ||
      agent.name.toLocaleLowerCase().includes(needle) ||
      sessions.some(
        (s) => s.agentId === agent.id && sessionLabel(s).toLocaleLowerCase().includes(needle),
      ),
  );
  return (
    <div className="px-2 pb-2">
      {(agents.length > 5 || sessions.length > 10) && (
        <label className="mb-3 flex min-h-9 items-center gap-2 rounded-md border border-input bg-background px-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="搜索智能体或会话"
            placeholder="搜索智能体或会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      )}
      {loading && <p className="px-2 py-4 text-sm text-muted-foreground">正在读取智能体…</p>}
      {error && (
        <div className="px-2 py-3 text-sm">
          <p className="text-destructive">对象列表加载失败：{error}</p>
          <button type="button" className="mt-2 min-h-9 text-info" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      <ul className="space-y-1">
        {visible.map((agent) => {
          const open = expanded === agent.id || Boolean(needle);
          const active = props.activeAgentId === agent.id;
          const encoded = encodeURIComponent(agent.id);
          const href =
            props.tab === "config" && agent.canRead !== false
              ? `/agents?id=${encoded}`
              : props.tab === "runs"
                ? `/settings/runs?agent=${encoded}`
                : props.tab === "integration"
                  ? `/settings/keys?agent=${encoded}`
                  : `/?agent=${encoded}`;
          const children = sessions
            .filter(
              (s) =>
                s.agentId === agent.id &&
                (!needle ||
                  agent.name.toLocaleLowerCase().includes(needle) ||
                  sessionLabel(s).toLocaleLowerCase().includes(needle)),
            )
            .sort((a, b) => activityOf(b) - activityOf(a));
          return (
            <li key={agent.id}>
              <div
                className={cn(
                  "flex min-h-11 items-center rounded-md",
                  active && "bg-sidebar-active",
                )}
              >
                <button
                  type="button"
                  aria-label={`${open ? "收起" : "展开"} ${agent.name} 的会话`}
                  aria-expanded={open}
                  className="flex min-h-11 w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded(open ? undefined : agent.id)}
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </button>
                <Link
                  href={href}
                  aria-current={active ? "true" : undefined}
                  title={`${agent.name} (${agent.id})`}
                  data-close-drawer=""
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 pr-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={(e) => {
                    if (props.onPickAgentAction) {
                      e.preventDefault();
                      if (props.running && !active) return;
                      props.onPickAgentAction(agent.id);
                    }
                    setExpanded(agent.id);
                  }}
                >
                  <Bot className="size-4 shrink-0 text-info" />
                  <span className="truncate">{agent.name}</span>
                  {agents.some((other) => other.id !== agent.id && other.name === agent.name) && (
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {agent.id.slice(0, 6)}
                    </span>
                  )}
                </Link>
              </div>
              {open && (
                <ul className="mb-4 ml-[18px] border-l border-input pl-2">
                  {children.map((s) => (
                    <li
                      key={s.id}
                      className={cn(
                        "group/session relative flex min-h-11 items-center rounded-md hover:bg-accent",
                        props.activeSessionId === s.id && "bg-sidebar-active",
                      )}
                    >
                      <Link
                        href={`/?session=${encodeURIComponent(s.id)}`}
                        data-close-drawer=""
                        title={sessionLabel(s)}
                        aria-current={props.activeSessionId === s.id ? "page" : undefined}
                        className={cn(
                          "flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 text-sm",
                          props.sessionActions && "pr-8",
                        )}
                        onClick={
                          props.onOpenSessionAction
                            ? (e) => {
                                e.preventDefault();
                                props.onOpenSessionAction?.(s.id);
                              }
                            : undefined
                        }
                      >
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="truncate">{sessionLabel(s)}</span>
                      </Link>
                      {props.sessionActions && (
                        <span className="absolute right-1 opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100">
                          {props.sessionActions(s)}
                        </span>
                      )}
                    </li>
                  ))}
                  <li>
                    <Link
                      href={`/?agent=${encodeURIComponent(agent.id)}`}
                      data-close-drawer=""
                      className="flex min-h-11 items-center gap-2 px-3 text-sm text-muted-foreground hover:text-foreground"
                      onClick={
                        props.onNewSessionAction
                          ? (e) => {
                              e.preventDefault();
                              if (props.running) return;
                              if (!active) props.onPickAgentAction?.(agent.id);
                              else props.onNewSessionAction?.();
                            }
                          : undefined
                      }
                    >
                      <Plus className="size-4" />
                      新建会话
                    </Link>
                  </li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {!loading && !error && visible.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">
          {needle ? "没有匹配的智能体或会话" : "还没有智能体"}
        </p>
      )}
    </div>
  );
}
