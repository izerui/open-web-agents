"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { AppShell } from "@/components/shell/app-shell";
import { followRun } from "@/features/chat/follow-run";
import { fetchJson } from "@/lib/fetch-json";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import type { FileUIPart } from "ai";
import {
  Archive,
  Bot,
  Command,
  Info,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalBar, type PendingQuestion } from "./approval-bar";
import { Spin } from "./chat-bits";
import { ChatHeader, type RightTab } from "./chat-header";
import { joinPromptAttachments, versionBadge } from "./chat-view.logic";
import { CommandPalette } from "./command-palette";
import { Composer, type QueuedMessage, type SlashCommand } from "./composer";
import {
  ChatThread,
  type SubmitAnswer,
  contextTokens,
  sumUsage,
  totalUsageTokens,
} from "./conversation";
import { createEventBatcher } from "./event-batcher";
import { FilePanel } from "./file-panel";
import { NewSessionDialog } from "./new-session-dialog";
import { RunTree } from "./run-tree";
import { sessionLabel } from "./session-groups";
import { type ListView, SessionList, type SessionWait } from "./session-list";
import { sendSteer } from "./steer-client";
import type { AgentSummary, SessionSummary, Turn } from "./types";
import { VariablePrompt } from "./variable-prompt";
import {
  agentIdFromSearch,
  promptFromSearch,
  sessionIdFromSearch,
  updateTurnByLocalId,
  withSessionInUrl,
} from "./workbench.logic";
import { makeWorkspaceFileDropHandlers } from "./workspace-file-drop";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  layoutStorage,
  useDefaultLayout,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { refreshModelCatalog } from "@/features/builder/model-select";

const RIGHT_KEY = "owa.chat.right";

/* ================================================================== */
/*  运行事件流                                                       */
/* ================================================================== */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function dataUrlToBlob(url: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) throw new Error("附件格式不受支持");
  const mediaType = match[1] ?? "application/octet-stream";
  const payload = match[3] ?? "";
  if (!match[2]) return new Blob([decodeURIComponent(payload)], { type: mediaType });
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mediaType });
}

async function responseError(res: Response, prefix: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ? `${prefix}:${body.error}` : `${prefix}(HTTP ${res.status})`);
}

function assertEventStreamResponse(res: Response): void {
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new Error(`运行接口返回了非事件流响应(${contentType || "未知类型"})`);
  }
}

async function uploadPromptFiles(
  sessionId: string,
  files: FileUIPart[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (files.length === 0) return [];
  const form = new FormData();
  for (const file of files) {
    if (!file.url.startsWith("data:")) throw new Error("附件必须先转换为本地数据");
    const blob = dataUrlToBlob(file.url);
    const filename = file.filename ?? "attachment";
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`文件过大: ${filename}`);
    form.append("files", blob, filename);
  }
  const res = await fetch(`/api/sessions/${sessionId}/files`, {
    method: "POST",
    body: form,
    signal,
  });
  const body = (await res.json().catch(() => null)) as { files?: string[]; error?: string } | null;
  if (!res.ok || !body?.files) throw new Error(body?.error ?? `上传文件失败(HTTP ${res.status})`);
  return body.files;
}

/** 内置通用智能体的开场建议(它没有配置自己的)。 */
const DEFAULT_AGENT_STARTERS = [
  "在工作目录写一个 hello.py",
  "帮我分析这个项目的架构",
  "创建一个简单的 REST API",
];

/** 空状态、错误状态共用的居中块 */
function EmptyBlock({
  icon,
  title,
  children,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-10 py-6 text-center max-md:px-5">
      {icon}
      <h2 className="mt-[18px] mb-1.5 font-display text-[28px] leading-[1.3] max-md:text-[22px]">
        {title}
      </h2>
      {children && <div className="max-w-[460px] text-muted-foreground">{children}</div>}
      {actions && <div className="mt-[22px] flex flex-wrap justify-center gap-2.5">{actions}</div>}
    </div>
  );
}

function BadIcon() {
  return (
    <span className="flex size-14 items-center justify-center rounded-full bg-destructive-soft text-destructive">
      <TriangleAlert className="size-6" />
    </span>
  );
}

export function Workbench() {
  const router = useRouter();
  const { me } = useMe();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  /**
   * 智能体列表的加载状态。曾经失败只弹一个 toast:之后 agents 为空、输入框永久禁用,
   * 页面上既没有原因也没有重试入口;还在加载时又和"真的没有智能体"长得一样。
   */
  const [agentsState, setAgentsState] = useState<"loading" | "ok" | "error">("loading");
  const [agentId, setAgentId] = useState("default");
  const [contextReady, setContextReady] = useState(false);
  const [agentContextError, setAgentContextError] = useState<string | null>(null);
  /** ?agent= 只在第一次拿到智能体列表时生效一次,之后的刷新不覆盖用户自己的选择 */
  const urlAgentPendingRef = useRef(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** 已归档的会话(左栏「已归档」视图,可恢复) */
  const [archived, setArchived] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  /**
   * 运行中提交的消息排在这里,本轮结束后依次发出(参照 Codex 的排队追问)。
   *
   * 曾经运行中按回车:send() 直接 return,输入框却以为提交成功,把文字和附件一起清空 ——
   * 用户写的东西静默丢失,也不知道为什么没发出去。
   */
  const [queued, setQueued] = useState<(QueuedMessage & { files: FileUIPart[] })[]>([]);
  /** 追加消息接口答"待定"(202)的那些:之后若在事件流里收到未送达,自动改为排队重发 */
  const pendingSteerRef = useRef(new Set<string>());
  const [filesKey, setFilesKey] = useState(0);
  /**
   * 会话列表【加载失败】。
   *
   * 【为什么必须和"空列表"分开】两者在界面上长得一模一样,但含义相反:
   * 一个是"你还没建过会话",一个是"你的会话还在,只是这次没读到"。
   * 光靠 toast 不够 —— 它几秒就消失,用户回头看到的还是"还没有会话"。
   */
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [listView, setListView] = useState<ListView>("active");
  const [listQuery, setListQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  /** 右侧面板当前是哪个页签;null = 关闭。 */
  const [rightTab, setRightTab] = useState<RightTab | null>(null);
  const [rightReady, setRightReady] = useState(false);
  /** 执行详情里选中的那次调用(对话流里点工具摘要也会定位到这里) */
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  /** 待你确认的工具名(审批条轮询带回) */
  const [awaitingTools, setAwaitingTools] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<{ abort: AbortController; runId?: string } | null>(null);
  /** 打开会话的序号:用来丢弃"切走之后才回来"的过期响应。 */
  const openSeqRef = useRef(0);
  const initialSessionAppliedRef = useRef(false);

  useEffect(
    () => () => {
      openSeqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      activeRunRef.current = null;
      pendingSteerRef.current.clear();
    },
    [],
  );

  const syncSessionUrl = useCallback((nextSessionId: string | null) => {
    const nextUrl = withSessionInUrl(window.location.href, nextSessionId);
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  // ?q= 预填输入框(探索页、市场详情带着一句话过来);只预填不发送,读完从地址里去掉
  useEffect(() => {
    const q = promptFromSearch(window.location.search);
    if (!q) return;
    setInput(q);
    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  // 右侧面板的状态从上次离开时恢复
  useEffect(() => {
    const right = localStorage.getItem(RIGHT_KEY);
    if (right === "files") setRightTab("files");
    else if (right === "runs") setRightTab("runs");
    setRightReady(true);
  }, []);
  useEffect(() => {
    if (!rightReady || mobileLayout) return;
    localStorage.setItem(RIGHT_KEY, rightTab ?? "none");
  }, [rightTab, rightReady, mobileLayout]);

  const toggleRight = useCallback((tab: RightTab) => {
    setRightTab((cur) => (cur === tab ? null : tab));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setMobileLayout(media.matches);
      // 窄屏下右侧面板是抽屉,进页面时不该自己弹出来
      if (media.matches) setRightTab(null);
    };
    update();
    setLayoutReady(true);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  /**
   * 拉会话列表(含智能体设计器的会话)与已归档列表。
   *
   * 【为什么不能直接 r.json()】接口 500 时响应体是空的,json() 会抛 SyntaxError,
   * 而这两条链原本既不看 res.ok 也没有 catch —— 于是变成 unhandledRejection,
   * 界面静默变成"一条历史都没有"的空白。
   */
  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const res = await fetch("/api/sessions?include=design");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { sessions?: SessionSummary[] };
      setSessions(d.sessions ?? []);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoaded(true);
    }
    // 归档列表只是附加视图:读不到不影响主列表,计数显示 0
    try {
      const res = await fetch("/api/sessions?archived=1&include=design");
      if (res.ok) {
        const d = (await res.json()) as { sessions?: SessionSummary[] };
        setArchived(d.sessions ?? []);
      }
    } catch {
      // 留着上次的归档列表
    }
  }, []);

  /**
   * 同步一个会话当前实际运行的模型。跟随草稿的会话,作者可能在别处改了模型:
   * 列表里的是加载时的快照,发送前与重新获得焦点时按服务端当前解析更新。
   */
  const syncSessionModel = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) return;
      const { session } = (await res.json()) as { session?: { id: string; model?: string } };
      if (!session) return;
      setSessions((all) =>
        all.map((s) =>
          s.id === session.id && s.model !== session.model ? { ...s, model: session.model } : s,
        ),
      );
    } catch {
      // 同步不到就沿用快照,不影响发送
    }
  }, []);

  const loadAgents = useCallback(() => {
    setAgentsState("loading");
    void fetch("/api/agents")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { agents?: AgentSummary[] };
      })
      .then((d) => {
        setAgentsState("ok");
        const nextAgents = d.agents ?? [];
        setAgents(nextAgents);
        // 从构建页"试运行"跳过来时 URL 带着 ?agent=,第一次加载时优先选中它。
        // 曾经只在"还没选中"时才采用 —— 而初始值是 "default",默认智能体可见时参数永远被忽略。
        // 同时带 ?session= 时以会话所属的智能体为准
        const search = window.location.search;
        const wanted =
          urlAgentPendingRef.current && !sessionIdFromSearch(search)
            ? agentIdFromSearch(search)
            : null;
        urlAgentPendingRef.current = false;
        setAgentId((currentId) => {
          if (wanted && nextAgents.some((agent) => agent.id === wanted)) return wanted;
          return nextAgents.some((agent) => agent.id === currentId)
            ? currentId
            : (nextAgents[0]?.id ?? "");
        });
      })
      .catch((e: unknown) => {
        // 智能体拉不到不该连累会话列表
        toast.error(`智能体列表加载失败:${e instanceof Error ? e.message : String(e)}`);
        setAgentsState("error");
      });
  }, []);

  useEffect(() => {
    loadAgents();
    void loadSessions();
  }, [loadAgents, loadSessions]);

  /**
   * 离开当前会话前断开本地事件流。运行不绑定在这个 HTTP 请求上,服务端照常跑完;
   * 切回来时从 /history 还原、从 /events 接回实时流。
   */
  const detach = useCallback(() => {
    openSeqRef.current += 1;
    pendingSteerRef.current.clear();
    setQueued([]);
    abortRef.current?.abort();
    abortRef.current = null;
    activeRunRef.current = null;
    setRunning(false);
    setSelectedTool(null);
  }, []);

  /** 开一个新会话(还没发消息时只在本地,发第一条时才真正创建) */
  const startNewSession = useCallback(
    (nextAgentId: string) => {
      detach();
      setSessionId(null);
      setAgentId(nextAgentId);
      setAgentContextError(null);
      const url = new URL(window.location.href);
      url.searchParams.set("agent", nextAgentId);
      url.searchParams.delete("session");
      window.history.replaceState(window.history.state, "", url);
      setTurns([]);
      setHistoryLoading(false);
      setHistoryError(null);
      setListView("active");
    },
    [detach],
  );

  /**
   * 中断 = 先告诉服务端取消,再断开本地流。
   *
   * 【只 abort 本地 fetch 是不够的】—— 运行不绑定在这个 HTTP 请求上(/run 的刻意设计)。
   * 光断本地流:界面显示已停止,而服务端 agent 继续调模型、继续执行工具、
   * 继续产生副作用与费用,直到 30 分钟墙钟上限。用户以为停了,其实没停。
   */
  const cancelRun = useCallback(async () => {
    const seq = openSeqRef.current;
    const markLocalCancelled = (summary: string) => {
      setTurns((all) =>
        all.map((turn) =>
          turn.running
            ? {
                ...turn,
                running: false,
                events: turn.events.some(
                  (event) => event.kind === "result" && event.status === "cancelled",
                )
                  ? turn.events
                  : [
                      ...turn.events,
                      { kind: "result" as const, status: "cancelled" as const, summary },
                    ],
              }
            : turn,
        ),
      );
      setRunning(false);
    };

    const activeRun = activeRunRef.current;
    // 会话或 run 尚在创建、附件仍在上传时，服务端还没有可取消记录。
    if (!sessionId || !activeRun?.runId) {
      activeRun?.abort.abort();
      activeRunRef.current = null;
      markLocalCancelled("已取消发送");
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: activeRun.runId }),
      });
      if (!res.ok) throw await responseError(res, "停止运行失败");
      const body = (await res.json()) as { cancelled?: string[]; note?: string };
      if (seq !== openSeqRef.current || activeRunRef.current !== activeRun) return;
      if ((body.cancelled?.length ?? 0) === 0) {
        toast.info(body.note ?? "运行已经结束");
      } else {
        markLocalCancelled(body.note ?? "已请求停止");
        activeRun.abort.abort();
        if (activeRunRef.current === activeRun) activeRunRef.current = null;
      }
    } catch (error) {
      if (seq === openSeqRef.current && activeRunRef.current === activeRun) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    }
  }, [sessionId]);

  /**
   * 打开一个历史会话:先把跑过的轮次还原出来,若其中一轮还在跑就接回实时流。
   *
   * 【为什么要还原】过程事件只活在 Redis 与进程内的 replay 缓冲里,运行一结束就没了,
   * 不还原的话用户刷新一下,刚才看到的思考、工具调用、产出全部消失。
   *
   * 【为什么历史与实时流不会重复】/history 只回【已终态】轮次的过程,仍在跑的那一轮
   * 由 /events 推 —— 两个来源各管一段。AgentEvent 里没有唯一 id,真要重了也去不掉,
   * 所以这个"不重复"必须由结构保证,而不是靠去重逻辑兜。
   */
  async function openSession(id: string) {
    // 切走之前必须断掉上一条流,否则旧会话的事件会继续灌进来 —— 而界面已经是新会话了
    abortRef.current?.abort();
    abortRef.current = null;
    activeRunRef.current = null;
    setRunning(false);
    setListOpen(false);
    setSelectedTool(null);

    const seq = ++openSeqRef.current;
    pendingSteerRef.current.clear();
    setQueued([]);
    const targetSession =
      sessions.find((session) => session.id === id) ?? archived.find((s) => s.id === id);
    if (targetSession) {
      setAgentId(targetSession.agentId);
      setAgentContextError(null);
    }
    setSessionId(id);
    syncSessionUrl(id);
    setTurns([]);
    setHistoryLoading(true);
    setHistoryError(null);
    setFilesKey((k) => k + 1);

    let history: { turns?: Turn[]; activeRunId?: string };
    try {
      const res = await fetch(`/api/sessions/${id}/history`);
      if (!res.ok) throw await responseError(res, "读取会话历史失败");
      history = (await res.json()) as typeof history;
    } catch (error) {
      if (seq === openSeqRef.current) {
        setHistoryError(error instanceof Error ? error.message : String(error));
      }
      return;
    } finally {
      if (seq === openSeqRef.current) setHistoryLoading(false);
    }

    // 拉取期间用户可能又切走了。丢弃过期响应,否则上一个会话的历史会画到当前界面上。
    if (seq !== openSeqRef.current) return;
    setTurns(history.turns ?? []);

    const activeRunId = history.activeRunId;
    if (!activeRunId) return;

    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    activeRunRef.current = { abort, runId: activeRunId };

    // 用 runId 定位当前历史轮，避免快速切换时把事件写入其它轮次。
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.runId === activeRunId ? fn(t) : t)));
    const batcher = createEventBatcher((events) =>
      patch((turn) => ({ ...turn, events: [...turn.events, ...events] })),
    );
    const push = batcher.push;

    try {
      await followRun({ sessionId: id, runId: activeRunId, push, signal: abort.signal });
    } catch (err) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(err) });
      }
    } finally {
      batcher.flush();
      // 已经切到别的会话了就别再动状态 —— 那些 setState 针对的是已经不在屏幕上的数据
      if (seq === openSeqRef.current) {
        patch((t) => ({ ...t, running: false }));
        setRunning(false);
        abortRef.current = null;
        if (activeRunRef.current?.abort === abort) activeRunRef.current = null;
        setFilesKey((k) => k + 1);
        void loadSessions();
      }
    }
  }

  // URL 只在会话列表首次成功加载后恢复一次；openSession 必须使用这一轮的 sessions 快照。
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time URL restoration
  useEffect(() => {
    if (
      !sessionsLoaded ||
      sessionsError !== null ||
      agentsState !== "ok" ||
      initialSessionAppliedRef.current
    )
      return;
    initialSessionAppliedRef.current = true;
    const requestedSessionId = sessionIdFromSearch(window.location.search);
    const known = [...sessions, ...archived].find((s) => s.id === requestedSessionId);
    if (requestedSessionId && known && known.source !== "design") {
      void openSession(requestedSessionId);
    } else {
      if (requestedSessionId) syncSessionUrl(null);
      const params = new URLSearchParams(window.location.search);
      if (params.has("agent")) {
        const requestedAgentId = params.get("agent") ?? "";
        if (requestedAgentId && agents.some((agent) => agent.id === requestedAgentId)) {
          setAgentId(requestedAgentId);
        } else {
          setAgentId("");
          setAgentContextError(
            requestedAgentId ? "找不到指定的智能体，或你没有访问权限。" : "链接缺少智能体 ID。",
          );
        }
      }
    }
    setContextReady(true);
  }, [agents, agentsState, sessions, sessionsError, sessionsLoaded, syncSessionUrl]);

  const activeSession = sessionId
    ? (sessions.find((s) => s.id === sessionId) ?? archived.find((s) => s.id === sessionId))
    : undefined;
  const isArchived = activeSession?.status === "archived";

  /**
   * 拿到可用的会话 id,没有就现建一个。
   *
   * 【为什么要校验返回体】建会话失败(未登录、库挂了)时 session 是 undefined,
   * 不校验的话下一行立刻 TypeError,用户点了发送,界面毫无反应,也没有任何提示。
   */
  async function ensureSession(firstPrompt: string, signal: AbortSignal): Promise<string> {
    if (!contextReady || agentContextError) throw new Error("请选择可用的智能体");
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 用第一句话当标题:曾经不带标题,侧栏里一列全是看不出内容的 id
      body: JSON.stringify({ agentId, title: firstPrompt.replace(/\s+/g, " ").slice(0, 40) }),
    });
    const body = (await res.json().catch(() => null)) as {
      session?: SessionSummary;
      error?: string;
    } | null;
    if (!res.ok || !body?.session) {
      throw new Error(body?.error ?? `创建会话失败(HTTP ${res.status})`);
    }
    const session = body.session;
    signal.throwIfAborted();
    setSessionId(session.id);
    syncSessionUrl(session.id);
    setSessions((s) => [{ ...session, source: "web", lastActiveAt: Date.now() }, ...s]);
    return session.id;
  }

  /**
   * 发起一轮。
   *
   * `text` 用于【非输入框来源】的发送 —— 开场建议、提问卡片「作为新消息发送」。
   * 不走输入框是有意的:那些不该先塞进输入框再让用户按回车,也不该把用户正在打的字冲掉。
   */
  async function send(text?: string, files: FileUIPart[] = [], clearComposer = false) {
    const prompt = (text ?? input).trim();
    if (!contextReady || agentContextError || !agentId || isArchived) return;
    if (!prompt || running || historyLoading || historyError !== null) return;
    setRunning(true);
    // 这一轮按服务端当前的模型与价格运行:顺便刷新标题栏显示
    void refreshModelCatalog();
    if (sessionId) void syncSessionModel(sessionId);

    const localId = crypto.randomUUID();
    const seq = openSeqRef.current;
    setTurns((currentTurns) => [
      ...currentTurns,
      { localId, prompt, events: [], running: true, startedAt: new Date().toISOString() },
    ]);
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((all) => updateTurnByLocalId(all, localId, fn));
    const batcher = createEventBatcher((events) =>
      patch((turn) => ({ ...turn, events: [...turn.events, ...events] })),
    );
    const push = batcher.push;

    const abort = new AbortController();
    abortRef.current = abort;
    const sendHandle: { abort: AbortController; runId?: string } = { abort };
    activeRunRef.current = sendHandle;

    try {
      const id = await ensureSession(prompt, abort.signal);
      abort.signal.throwIfAborted();
      if (seq !== openSeqRef.current) throw new Error("会话已经切换");
      const uploadedFiles = await uploadPromptFiles(id, files, abort.signal);
      abort.signal.throwIfAborted();
      const runPrompt = joinPromptAttachments(prompt, uploadedFiles);
      if (uploadedFiles.length) {
        patch((turn) => ({ ...turn, prompt: runPrompt }));
      }
      const res = await fetch(`/api/sessions/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: runPrompt }),
        signal: abort.signal,
      });
      if (!res.ok) throw await responseError(res, "发起运行失败");
      assertEventStreamResponse(res);
      if (!res.body) throw new Error("运行接口没有返回事件流");

      // runId 是重连和分支的身份，缺失时不能假装已经可靠入队。
      const runId = res.headers.get("X-Run-Id");
      if (!runId) throw new Error("运行接口没有返回 runId");
      sendHandle.runId = runId;
      patch((turn) => ({ ...turn, runId }));
      if (clearComposer) setInput("");

      // 提交 Promise 在“可靠入队”后就完成，让 PromptInput 此时清附件；
      // 长时间的 SSE 消费留在后台，失败则继续写回同一个稳定 localId 的轮次。
      void (async () => {
        try {
          await followRun({
            sessionId: id,
            runId,
            push,
            signal: abort.signal,
            initial: res.body,
          });
        } catch (error) {
          if (!abort.signal.aborted) {
            push({ kind: "result", status: "failed", summary: String(error), runId });
          }
        } finally {
          batcher.flush();
          if (seq === openSeqRef.current) {
            patch((turn) => ({ ...turn, running: false }));
            setRunning(false);
            if (abortRef.current === abort) abortRef.current = null;
            if (activeRunRef.current === sendHandle) activeRunRef.current = null;
            setFilesKey((key) => key + 1);
            void loadSessions();
          }
        }
      })();
    } catch (error) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(error) });
      }
      batcher.flush();
      if (seq === openSeqRef.current) {
        patch((turn) => ({ ...turn, running: false }));
        setRunning(false);
        if (abortRef.current === abort) abortRef.current = null;
        if (activeRunRef.current === sendHandle) activeRunRef.current = null;
      }
      throw error;
    }
  }

  /**
   * 重跑某一轮:回到那一轮【之前】的状态重来(之前的对话都在,那一轮及之后的不在),
   * 再挂上事件流看它跑。已有记录原样保留,不被覆盖。
   * 较早的记录定位不了那一轮之前的状态时,改为干净上下文重跑,并如实提示。
   */
  async function rerun(fromRunId: string, prompt: string) {
    if (!sessionId || running || isArchived) return;
    setRunning(true);

    const localId = crypto.randomUUID();
    const seq = openSeqRef.current;
    const targetSessionId = sessionId;
    setTurns((currentTurns) => [
      ...currentTurns,
      {
        localId,
        prompt,
        events: [],
        running: true,
        branchedFrom: fromRunId,
        startedAt: new Date().toISOString(),
      },
    ]);
    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((all) => updateTurnByLocalId(all, localId, fn));
    const batcher = createEventBatcher((events) =>
      patch((turn) => ({ ...turn, events: [...turn.events, ...events] })),
    );
    const push = batcher.push;

    const abort = new AbortController();
    abortRef.current = abort;
    const rerunHandle: { abort: AbortController; runId?: string } = { abort };
    activeRunRef.current = rerunHandle;

    try {
      const branch = (mode: "rewind" | "fresh") =>
        fetch(`/api/sessions/${targetSessionId}/branch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromRunId, mode, prompt }),
          signal: abort.signal,
        });
      let res = await branch("rewind");
      let data = (await res.json().catch(() => null)) as {
        runId?: string;
        error?: string;
        code?: string;
      } | null;
      if (res.status === 409 && data?.code === "rewind_unavailable") {
        toast.message("这一轮之前的对话状态无法精确定位(较早的记录),改为干净上下文重跑");
        res = await branch("fresh");
        data = (await res.json().catch(() => null)) as typeof data;
      }
      if (!res.ok || !data?.runId) {
        throw new Error(data?.error ?? `重跑失败(HTTP ${res.status})`);
      }
      rerunHandle.runId = data.runId;
      patch((turn) => ({ ...turn, runId: data.runId }));

      await followRun({
        sessionId: targetSessionId,
        runId: data.runId,
        push,
        signal: abort.signal,
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(error) });
      }
    } finally {
      batcher.flush();
      if (seq === openSeqRef.current) {
        patch((turn) => ({ ...turn, running: false }));
        setRunning(false);
        if (abortRef.current === abort) abortRef.current = null;
        if (activeRunRef.current === rerunHandle) activeRunRef.current = null;
        setFilesKey((key) => key + 1);
        void loadSessions();
      }
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    const onFocus = () => void syncSessionModel(sessionId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessionId, syncSessionModel]);

  const current = agents.find((a) => a.id === agentId);
  // 已有会话按它实际运行的版本显示模型(锁定的发布版可能与草稿不同);
  // 还没有会话时,列表给的配置正是新会话会用的那一版(能编辑的人是草稿,其他人是发布版)
  const shownModel = activeSession ? activeSession.model : current?.config.model;
  // 开场建议按智能体配置;曾经写死成编程示例,对"发票抽取"之类的智能体毫无意义
  const starters = (
    current?.config.starters ?? (current?.id === "default" ? DEFAULT_AGENT_STARTERS : [])
  ).slice(0, 4);
  // 一个智能体都没有时,agentId 还是兜底的 "default",不能拿它当名字显示
  const hasAgents = agents.length > 0;
  const composerBlocked =
    !contextReady ||
    agentContextError !== null ||
    historyLoading ||
    historyError !== null ||
    !hasAgents ||
    isArchived;
  const contextUsed = useMemo(() => contextTokens(turns), [turns]);
  const totalProcessed = useMemo(() => {
    const all = turns.flatMap((t) => t.events);
    const total = totalUsageTokens(sumUsage(all));
    return total > 0 ? total : null;
  }, [turns]);

  const dropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive,
        addFiles() {
          // PromptInput globalDrop owns attachment state and performs validation.
        },
      }),
    [],
  );

  // 记住用户拖出来的分栏宽度,下次进来还是这个宽度
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "chat-panels",
    panelIds: ["chat", "side"],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  // send 必须读取当前轮次与运行状态;把它包装进 useCallback 会扩大本组件的状态依赖面。
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally use the current send closure
  const handlePromptSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim() || (message.files.length > 0 ? "请查看附件。" : "");
      if (!text) return;
      if (running) {
        const runId = activeRunRef.current?.runId;
        // 纯文本:直接追加进正在跑的这一轮;带附件的(追加只能带文本)或还拿不到 runId 时照旧排队
        if (message.files.length === 0 && runId && sessionId) {
          setInput("");
          void steerOrQueue(sessionId, runId, text);
          return;
        }
        setQueued((q) => [...q, { id: crypto.randomUUID(), text, files: message.files }]);
        setInput("");
        toast.message("已排队,本轮结束后发送");
        return;
      }
      return send(text, message.files, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      running,
      cancelRun,
      input,
      contextReady,
      agentContextError,
      agentId,
      sessionId,
      historyLoading,
      historyError,
      isArchived,
    ],
  );

  /**
   * 运行中追加一条消息(发送策略见 steer-client.ts)。
   * 只有明确"没受理 / 没送达"才改为本轮结束后作为新消息发送;不确定时绝不自动重发 ——
   * 那条可能已经交给了智能体,再发一遍就执行两次。
   */
  async function steerOrQueue(sid: string, runId: string, text: string) {
    const seq = openSeqRef.current;
    const id = crypto.randomUUID();
    // The stream may report delivery before the HTTP acknowledgement arrives.
    pendingSteerRef.current.add(id);
    const r = await sendSteer({ sessionId: sid, runId, id, text });
    if (seq !== openSeqRef.current) return;
    switch (r.kind) {
      case "delivered":
        if (pendingSteerRef.current.delete(id)) toast.success("已交给智能体");
        return;
      case "pending":
        if (pendingSteerRef.current.has(id)) toast.message("已提交,等待智能体接收");
        return;
      case "unconfirmed":
        // 结局若之后从事件流里来(未送达),照样会自动改为排队
        if (pendingSteerRef.current.has(id)) {
          toast.warning("暂时无法确认这条是否已交给智能体,请留意它的回答;确认没收到再重新发送");
        }
        return;
      case "invalid":
        pendingSteerRef.current.delete(id);
        toast.error(r.message);
        return;
      case "resend":
        if (!pendingSteerRef.current.delete(id)) return;
        setQueued((q) => [...q, { id: crypto.randomUUID(), text, files: [] }]);
        toast.message("这一轮正在收尾,本轮结束后作为新消息发送");
        return;
    }
  }

  // 待定的追加消息最终没送达:改为排队,本轮结束后作为新消息发送
  useEffect(() => {
    for (const turn of turns) {
      for (const e of turn.events) {
        if (e.kind !== "steer" || !e.id) continue;
        if (!pendingSteerRef.current.delete(e.id)) continue;
        if (e.outcome === "dropped") {
          setQueued((q) => [...q, { id: crypto.randomUUID(), text: e.text, files: [] }]);
        }
      }
    }
  }, [turns]);

  // 本轮结束、且当前会话可以发送时,发出排在最前的一条
  // biome-ignore lint/correctness/useExhaustiveDependencies: send 每次渲染都是新闭包,只在状态变化时触发
  useEffect(() => {
    if (running || historyLoading || historyError !== null) return;
    const next = queued[0];
    if (!next) return;
    setQueued((q) => q.slice(1));
    void send(next.text, next.files).catch(() => {});
  }, [running, historyLoading, historyError, queued]);

  const sendRef = useRef(send);
  const rerunRef = useRef(rerun);
  sendRef.current = send;
  rerunRef.current = rerun;
  const stableAnswerAction = useCallback(
    (text: string) => void sendRef.current(text).catch(() => {}),
    [],
  );
  /** 运行在等回答的提问(审批条轮询带回,在对话里的提问卡片上作答) */
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  /** 作答后让审批条立刻重新拉取,卡片马上从"待回答"变过来 */
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  const submitAnswerAction = useCallback<SubmitAnswer>(
    async (approvalId, body) => {
      if (!sessionId) return;
      await fetchJson(`/api/sessions/${sessionId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          "decline" in body
            ? { approvalId, decision: "denied" }
            : { approvalId, decision: "approved", answers: body.answers },
        ),
      });
      setApprovalRefresh((n) => n + 1);
    },
    [sessionId],
  );
  const stableRerunAction = useCallback(
    (runId: string, prompt: string) => void rerunRef.current(runId, prompt),
    [],
  );
  const locateTool = useCallback((locator: string) => {
    setSelectedTool(locator);
    setRightTab("runs");
  }, []);

  const openPicker = useCallback(() => {
    setListOpen(false);
    setPickerOpen(true);
  }, []);

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      { name: "new", label: "新建会话", icon: Plus, run: openPicker },
      {
        name: "search",
        label: "搜索会话与页面（⌘K）",
        icon: Command,
        run: () => setPaletteOpen(true),
      },
      { name: "agents", label: "管理智能体", icon: Bot, run: () => router.push("/agents") },
      {
        name: "stop",
        label: "停止当前运行",
        icon: Square,
        disabled: !running,
        run: () => void cancelRun(),
      },
    ],
    [cancelRun, openPicker, router, running],
  );

  const pickAgent = (id: string) => {
    setPickerOpen(false);
    startNewSession(id);
  };

  const restoreSession = async (id: string) => {
    try {
      await fetchJson(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const label = sessionLabel(archived.find((s) => s.id === id) ?? { id });
      toast.success(`已恢复「${label}」`);
      if (id === sessionId) {
        setSessions((all) => [
          ...all,
          ...archived.filter((s) => s.id === id).map((s) => ({ ...s, status: "active" })),
        ]);
      }
      setArchived((all) => all.filter((s) => s.id !== id));
      void loadSessions();
    } catch (e) {
      toast.error(`恢复失败:${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onRemoved = (id: string) => {
    setSessions((all) => all.filter((item) => item.id !== id));
    void loadSessions();
    if (id === sessionId) {
      detach();
      setSessionId(null);
      syncSessionUrl(null);
      setTurns([]);
    }
  };

  const wait: SessionWait =
    awaitingTools.length > 0 ? "approval" : pendingQuestions.length > 0 ? "ask" : null;
  const runningSession = running && activeSession ? sessionLabel(activeSession) : null;
  const badge = versionBadge({ running, session: activeSession, agent: current });

  const sessionList = (
    <SessionList
      view={listView}
      onViewChangeAction={(v) => {
        setListView(v);
        setListQuery("");
      }}
      query={listQuery}
      onQueryChangeAction={setListQuery}
      sessions={sessions}
      archived={archived}
      agents={agents}
      loaded={sessionsLoaded}
      error={sessionsError}
      onRetryAction={() => void loadSessions()}
      activeSessionId={sessionId}
      running={running}
      wait={wait}
      onOpenAction={(id) => void openSession(id)}
      onNewAction={openPicker}
      onChangedAction={() => void loadSessions()}
      onRemovedAction={onRemoved}
      onRestoreAction={(id) => void restoreSession(id)}
    />
  );

  const purgedAt = activeSession?.workspacePurgedAt;
  const bars = (
    <>
      {contextReady && !agentContextError && hasAgents && (
        <VariablePrompt
          key={`${agentId}-${sessionId ?? ""}`}
          agentId={agentId}
          sessionId={sessionId}
        />
      )}
      {purgedAt && (
        <output className="mx-5 mt-2.5 flex items-start gap-2 rounded-[10px] bg-[#EEF1F4] px-3 py-2 text-sm text-[#34465A] max-md:mx-3">
          <Info className="mt-0.5 size-[15px] shrink-0" />
          <span>
            这个会话长期未活动，工作目录已于 {new Date(purgedAt).toLocaleString()}{" "}
            自动清理，之前生成的文件已不在。对话记录还在；继续对话会在新的空目录里进行。
          </span>
        </output>
      )}
      {isArchived && sessionId && (
        <div className="mx-5 mt-2.5 flex items-center gap-2 rounded-[10px] bg-[#F4F2EC] px-3 py-2 text-sm text-[#3C3A35] max-md:mx-3">
          <Archive className="size-[15px] shrink-0" />
          <span className="min-w-0 flex-1">这个会话已归档，恢复后才能继续对话</span>
          <button
            type="button"
            className="shrink-0 underline decoration-[#C9C4B8] underline-offset-[3px]"
            onClick={() => void restoreSession(sessionId)}
          >
            恢复会话
          </button>
        </div>
      )}
    </>
  );

  let stream: React.ReactNode;
  if (agentsState === "ok" && !hasAgents) {
    // 没有任何可用智能体时,"发一句话试试"配一个禁用的输入框是自相矛盾的
    stream = (
      <EmptyBlock
        icon={<AgentAvatar id="default" size={64} />}
        title="还没有可用的智能体"
        actions={
          <>
            <Button asChild>
              <Link href="/agents">
                <Plus />
                新建智能体
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">去探索看看</Link>
            </Button>
          </>
        }
      >
        先创建一个智能体，或请管理员分享给你。也可以去探索里找一个现成的。
      </EmptyBlock>
    );
  } else if (agentContextError) {
    const recent = sessions.find((s) => s.source !== "design");
    stream = (
      <EmptyBlock
        icon={<BadIcon />}
        title={agentContextError}
        actions={
          <>
            <Button
              onClick={() =>
                recent ? void openSession(recent.id) : startNewSession(agents[0]?.id ?? "default")
              }
            >
              {recent ? "回到最近会话" : "开始新会话"}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">去探索找智能体</Link>
            </Button>
          </>
        }
      >
        可能链接拼错了、智能体已被删除，或作者没有分享给你。
      </EmptyBlock>
    );
  } else if (historyLoading) {
    stream = (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2.5 text-muted-foreground">
        <Spin />
        正在读取会话历史…
      </div>
    );
  } else if (historyError) {
    stream = (
      <EmptyBlock
        icon={<BadIcon />}
        title="读取会话历史失败"
        actions={
          sessionId && (
            <Button onClick={() => void openSession(sessionId)}>
              <RefreshCw />
              重试
            </Button>
          )
        }
      >
        {historyError}。会话本身没有丢失。
      </EmptyBlock>
    );
  } else if (turns.length === 0) {
    stream =
      agentsState === "error" ? (
        <EmptyBlock
          icon={<BadIcon />}
          title="智能体列表没读到"
          actions={
            <Button onClick={loadAgents}>
              <RefreshCw />
              重试
            </Button>
          }
        />
      ) : agentsState === "loading" || !contextReady ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2.5 text-muted-foreground">
          <Spin />
          正在读取…
        </div>
      ) : (
        <EmptyBlock
          icon={<AgentAvatar id={agentId} icon={current?.icon} size={64} />}
          title={current ? `和「${current.name}」开始对话` : "开始对话"}
        >
          <p>{current?.description || "描述你要它完成的事，它会在独立的工作目录里动手。"}</p>
          {starters.length > 0 && !isArchived && (
            <div className="mx-auto mt-6 grid w-[min(560px,100%)] grid-cols-2 gap-2.5 max-md:grid-cols-1">
              {starters.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => void send(text).catch(() => {})}
                  className="flex min-h-11 items-center gap-2 rounded-[14px] border border-border bg-[#FBFAF7] px-3.5 py-3 text-left text-sm text-foreground hover:border-[#BDB8AC] hover:bg-card"
                >
                  <MessageSquare className="size-[15px] shrink-0 text-muted-foreground" />
                  {text}
                </button>
              ))}
            </div>
          )}
        </EmptyBlock>
      );
  } else {
    stream = (
      <ChatThread
        key={sessionId ?? "new-session"}
        agentName={current?.name ?? activeSession?.agentId}
        agentId={agentId}
        agentIcon={current?.icon}
        turns={turns}
        onRerunAction={stableRerunAction}
        onAnswerAction={stableAnswerAction}
        pendingQuestions={pendingQuestions}
        submitAnswerAction={submitAnswerAction}
        onLocateToolAction={locateTool}
        selectedToolLocator={rightTab === "runs" ? selectedTool : null}
        readOnly={isArchived}
        awaitingTools={awaitingTools}
      />
    );
  }

  const placeholder = isArchived
    ? "这个会话已归档，恢复后才能继续对话"
    : historyError
      ? "会话历史没读到，暂时不能发消息"
      : running
        ? "运行中也可以继续补充"
        : "说点什么，或输入 /";

  const chatCard = (
    <div
      data-conversation-shell=""
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-border bg-card max-md:rounded-none max-md:border-0"
      onDragEnter={dropHandlers.onDragEnter as React.DragEventHandler}
      onDragOver={dropHandlers.onDragOver as React.DragEventHandler}
      onDragLeave={dropHandlers.onDragLeave as React.DragEventHandler}
      onDrop={dropHandlers.onDrop as React.DragEventHandler}
    >
      <ChatHeader
        title={activeSession ? sessionLabel(activeSession) : "新会话"}
        agent={agentContextError ? undefined : current}
        badge={agentContextError || !current ? undefined : badge}
        model={agentContextError ? undefined : shownModel}
        rightTab={rightTab}
        onToggleAction={toggleRight}
        onOpenListAction={() => setListOpen(true)}
      />
      {bars}
      <div className="relative flex min-h-0 flex-1 flex-col">{stream}</div>
      <div className="shrink-0 pt-1">
        <ApprovalBar
          key={sessionId ?? "new"}
          sessionId={sessionId}
          running={running}
          onQuestionsChange={setPendingQuestions}
          onApprovalsChange={setAwaitingTools}
          refreshKey={approvalRefresh}
        />
        <Composer
          input={input}
          onInputChangeAction={setInput}
          running={running}
          blocked={composerBlocked}
          placeholder={placeholder}
          onSubmitAction={handlePromptSubmit}
          onStopAction={() => void cancelRun()}
          commands={slashCommands}
          queued={queued}
          onUnqueueAction={(id) => setQueued((all) => all.filter((x) => x.id !== id))}
          contextUsed={contextUsed}
          totalProcessed={totalProcessed}
        />
      </div>
    </div>
  );

  const panelTabs = (
    <div className="flex shrink-0 items-center gap-2 border-b border-line-soft py-2.5 pr-3 pl-3.5">
      <div className="inline-flex rounded-full bg-[#ECEAE3] p-[3px]">
        {(
          [
            ["files", "工作区文件"],
            ["runs", "执行详情"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={rightTab === key}
            onClick={() => setRightTab(key)}
            className={cn(
              "h-[30px] rounded-full px-3.5 text-[13px] text-muted-foreground max-md:h-10",
              rightTab === key &&
                "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/6%)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="关闭面板"
        title="关闭面板"
        onClick={() => setRightTab(null)}
        className="ml-auto flex size-8 items-center justify-center rounded-full hover:bg-[#F0EEE8] max-md:size-11"
      >
        <X className="size-4" />
      </button>
    </div>
  );
  const panelBody =
    rightTab === "runs" ? (
      <RunTree
        turns={turns}
        agentName={current?.name}
        selected={selectedTool}
        onSelectAction={setSelectedTool}
        running={running}
      />
    ) : (
      <FilePanel
        sessionId={sessionId}
        refreshKey={filesKey}
        live={running}
        onSuggestAction={
          isArchived
            ? undefined
            : () => {
                setInput("把这次的结果整理成一个文件放到工作区");
                if (mobileLayout) setRightTab(null);
              }
        }
      />
    );

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChangeAction={setPaletteOpen}
        // 全部会话:命令面板是全局搜索,不该被侧栏搜索词收窄
        sessions={sessions.filter((s) => s.source !== "design")}
        agents={agents}
        currentAgentId={agentId}
        running={running}
        onOpenSessionAction={(id) => void openSession(id)}
        onNewSessionAction={openPicker}
        onPickAgentAction={pickAgent}
      />
      <NewSessionDialog
        open={pickerOpen}
        onOpenChangeAction={setPickerOpen}
        agents={agents}
        agentsState={agentsState}
        onRetryAction={loadAgents}
        meId={me?.user?.id ?? null}
        runningTitle={runningSession}
        onPickAction={pickAgent}
      />

      <AppShell fullBleed onSearchAction={() => setPaletteOpen(true)}>
        <div className="flex min-h-0 flex-1">
          <aside className="w-[268px] shrink-0 border-r border-border max-md:hidden">
            {sessionList}
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1">
            {!layoutReady ? (
              <div className="h-full w-full" aria-hidden="true" />
            ) : mobileLayout ? (
              chatCard
            ) : (
              <ResizablePanelGroup
                className="min-h-0 flex-1"
                defaultLayout={defaultLayout}
                onLayoutChanged={onLayoutChanged}
              >
                {/* 尺寸必须带单位:v4 把裸数字当像素 */}
                <ResizablePanel
                  id="chat"
                  defaultSize="66%"
                  minSize="40%"
                  className={cn("flex min-w-0 flex-col py-4 pl-4", !rightTab && "pr-4")}
                >
                  {chatCard}
                </ResizablePanel>
                {rightTab && (
                  <>
                    <ResizableHandle className="w-4 bg-transparent before:absolute before:top-[40%] before:left-[7px] before:h-[20%] before:w-[3px] before:rounded-sm before:bg-[#D9D5CB] before:transition-colors hover:before:bg-[#8E897D] focus-visible:before:bg-[#8E897D] data-[separator=active]:before:bg-[#8E897D]" />
                    <ResizablePanel
                      id="side"
                      defaultSize="34%"
                      minSize="16%"
                      maxSize="45%"
                      className="flex min-w-0 flex-col py-4 pr-4"
                    >
                      <section
                        aria-label={rightTab === "runs" ? "执行详情" : "工作区文件"}
                        className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-border bg-card"
                      >
                        {panelTabs}
                        <div className="min-h-0 flex-1">{panelBody}</div>
                      </section>
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            )}
          </div>
        </div>

        {/* 窄屏:会话列表与右侧面板改抽屉 */}
        <Sheet open={mobileLayout && listOpen} onOpenChange={setListOpen}>
          <SheetContent side="left" className="w-[88vw] max-w-80 gap-0 p-0 pt-10">
            <SheetTitle className="sr-only">会话列表</SheetTitle>
            <SheetDescription className="sr-only">切换、搜索、管理会话</SheetDescription>
            {sessionList}
          </SheetContent>
        </Sheet>
        <Sheet
          open={mobileLayout && rightTab !== null}
          onOpenChange={(open) => {
            if (!open) setRightTab(null);
          }}
        >
          <SheetContent side="right" showCloseButton={false} className="w-[92vw] gap-0 p-0">
            <SheetTitle className="sr-only">
              {rightTab === "runs" ? "执行详情" : "工作区文件"}
            </SheetTitle>
            <SheetDescription className="sr-only">
              查看当前会话的文件或工具执行过程
            </SheetDescription>
            {panelTabs}
            <div className="min-h-0 flex-1">{panelBody}</div>
          </SheetContent>
        </Sheet>

        {/* 拖拽覆盖层 */}
        {dragActive && (
          <div className="pointer-events-none fixed inset-0 z-[85] flex items-center justify-center bg-[rgb(247_246_242/86%)]">
            <div className="rounded-3xl border-2 border-dashed border-[#9C978B] bg-card px-20 py-12 text-center max-md:px-8">
              <Upload className="mx-auto size-9" />
              <p className="mt-3 mb-1 font-display text-[26px]">松手添加文件</p>
              <p className="text-muted-foreground">
                单个文件不超过 10MB，会先上传到这个会话的工作目录
              </p>
            </div>
          </div>
        )}
      </AppShell>
    </>
  );
}
