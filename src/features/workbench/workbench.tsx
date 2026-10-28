"use client";

import { AgentTree } from "@/components/ide/agent-tree";
import { IdeFrame } from "@/components/ide/ide-frame";
import { followRun } from "@/features/chat/follow-run";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import type { FileUIPart } from "ai";
import {
  AlertTriangle,
  Bot,
  Command,
  FolderOpen,
  ListTree,
  MessageSquare,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalBar, type PendingQuestion } from "./approval-bar";
import { CommandPalette } from "./command-palette";
import { ContextWindowMeter } from "./context-window-meter";
import {
  ChatThread,
  type SubmitAnswer,
  contextTokens,
  sumUsage,
  totalUsageTokens,
} from "./conversation";
import { createEventBatcher } from "./event-batcher";
import { FilePanel } from "./file-panel";
import { RunTree } from "./run-tree";
import { SessionActions } from "./session-actions";
import { sessionLabel } from "./session-groups";
import { sendSteer } from "./steer-client";
import type { AgentSummary, SessionSummary, Turn } from "./types";
import { VariablePrompt } from "./variable-prompt";
import {
  agentIdFromSearch,
  sessionIdFromSearch,
  updateTurnByLocalId,
  withSessionInUrl,
} from "./workbench.logic";
import { makeWorkspaceFileDropHandlers } from "./workspace-file-drop";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  layoutStorage,
  useDefaultLayout,
} from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { refreshModelCatalog } from "@/features/builder/model-select";
import { ModelPrice } from "@/features/models/model-price";

const RIGHT_KEY = "owa.object-workspace.right";

interface SlashCommand {
  name: string;
  label: string;
  icon: React.ElementType;
  disabled?: boolean;

  run(): void;
}

function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect(command: SlashCommand): void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          disabled={command.disabled}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:opacity-40",
            index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
        >
          <command.icon className="size-4 text-muted-foreground" />
          <span className="font-mono text-xs">/{command.name}</span>
          <span className="text-xs text-muted-foreground">{command.label}</span>
        </button>
      ))}
    </div>
  );
}

function AttachmentsDisplay() {
  const { files, remove } = usePromptInputAttachments();

  if (files.length === 0) return null;

  return (
    <Attachments>
      {files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => remove(file.id)}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

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

export function Workbench() {
  const router = useRouter();
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
  const [queued, setQueued] = useState<{ id: string; text: string; files: FileUIPart[] }[]>([]);
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
  const [slashIndex, setSlashIndex] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  /** 右侧工具窗口当前是哪个标签;null = 收起。 */
  const [rightTab, setRightTab] = useState<"files" | "runs" | null>(null);
  const [rightReady, setRightReady] = useState(false);
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

  // 右侧工具窗口的状态从上次离开时恢复
  useEffect(() => {
    const right = localStorage.getItem(RIGHT_KEY);
    if (right === "files") setRightTab("files");
    else if (right === "runs") setRightTab("runs");
    setRightReady(true);
  }, []);
  useEffect(() => {
    if (!rightReady) return;
    localStorage.setItem(RIGHT_KEY, rightTab ?? "none");
  }, [rightTab, rightReady]);

  const toggleRight = useCallback((tab: "files" | "runs") => {
    setRightTab((cur) => (cur === tab ? null : tab));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobileLayout(media.matches);
    update();
    setLayoutReady(true);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  /**
   * 拉智能体与会话列表。
   *
   * 【为什么不能直接 r.json()】接口 500 时响应体是空的,json() 会抛 SyntaxError,
   * 而这两条链原本既不看 res.ok 也没有 catch —— 于是变成 unhandledRejection,
   * 智能体和会话【双双设不进去】,界面静默变成"一条历史都没有"的空白。
   * 用户看到的是"数据没了",实际只是一个接口挂了,而且屏幕上没有任何线索。
   */
  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { sessions?: SessionSummary[] };
      setSessions(d.sessions ?? []);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoaded(true);
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
        // 从构建器"试运行"跳过来时 URL 带着 ?agent=,第一次加载时优先选中它。
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
        // 智能体拉不到不该连累会话列表 —— 原来两条链共用一个 effect 且都没 catch,
        // 任一失败都变成 unhandledRejection,两边一起空掉
        toast.error(`智能体列表加载失败:${e instanceof Error ? e.message : String(e)}`);
        setAgentsState("error");
      });
  }, []);

  useEffect(() => {
    loadAgents();
    void loadSessions();
  }, [loadAgents, loadSessions]);

  const newSession = useCallback(() => {
    if (running) return;
    openSeqRef.current += 1;
    pendingSteerRef.current.clear();
    setQueued([]);
    abortRef.current?.abort();
    abortRef.current = null;
    activeRunRef.current = null;
    setSessionId(null);
    syncSessionUrl(null);
    const url = new URL(window.location.href);
    url.searchParams.set("agent", agentId);
    window.history.replaceState(window.history.state, "", url);
    setTurns([]);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [agentId, running, syncSessionUrl]);

  /**
   * 中断 = 先告诉服务端取消,再断开本地流。
   *
   * 【只 abort 本地 fetch 是不够的】—— 运行不绑定在这个 HTTP 请求上(/run 的刻意设计)。
   * 光断本地流:界面显示已停止,而服务端 agent 继续调模型、继续执行工具、
   * 继续产生副作用与费用,直到 30 分钟墙钟上限。用户以为停了,其实没停。
   */
  const cancelRun = useCallback(async () => {
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
      if ((body.cancelled?.length ?? 0) === 0) {
        toast.info(body.note ?? "运行已经结束");
      } else {
        markLocalCancelled(body.note ?? "已请求停止");
        activeRun.abort.abort();
        if (activeRunRef.current === activeRun) activeRunRef.current = null;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId]);

  /**
   * 打开一个历史会话:先把跑过的轮次还原出来,若其中一轮还在跑就接回实时流。
   *
   * 【为什么要还原】这里曾经只做 setTurns([]) —— 打开历史会话是一片空白。
   * 过程事件只活在 Redis 与进程内的 replay 缓冲里,运行一结束就没了,
   * 用户刷新一下,刚才看到的思考、工具调用、产出全部消失。
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

    const seq = ++openSeqRef.current;
    pendingSteerRef.current.clear();
    setQueued([]);
    const targetSession = sessions.find((session) => session.id === id);
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
    if (requestedSessionId && sessions.some((session) => session.id === requestedSessionId)) {
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

  /**
   * 拿到可用的会话 id,没有就现建一个。
   *
   * 【为什么要校验返回体】这里原本直接解构 `{ session }` 就用 `session.id`:
   * 建会话失败(未登录、库挂了)时 session 是 undefined,下一行立刻 TypeError,
   * 而这个异常发生在发送流程内部 —— 用户点了发送,界面毫无反应,也没有任何提示。
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
    setSessions((s) => [session, ...s]);
    return session.id;
  }

  /**
   * 发起一轮。
   *
   * `text` 用于【非输入框来源】的发送 —— 目前是用户点了 agent 提问里的选项。
   * 不走输入框是有意的:那些选项是 agent 给的,不该先塞进输入框再让用户按回车,
   * 也不该把用户正在打的字冲掉。
   */
  async function send(text?: string, files: FileUIPart[] = [], clearComposer = false) {
    const prompt = (text ?? input).trim();
    if (!contextReady || agentContextError || !agentId) return;
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
      const runPrompt = uploadedFiles.length
        ? `${prompt}\n\n已上传到当前工作区的附件:\n${uploadedFiles.map((name) => `- ${name}`).join("\n")}`
        : prompt;
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
    if (!sessionId || running) return;
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
  const activeSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const shownModel = activeSession ? activeSession.model : current?.config.model;
  // 开场建议按智能体配置;曾经写死成编程示例,对"发票抽取"之类的智能体毫无意义
  const starters =
    current?.config.starters ?? (current?.id === "default" ? DEFAULT_AGENT_STARTERS : []);
  // 一个智能体都没有时,agentId 还是兜底的 "default",不能拿它当名字显示
  const hasAgents = agents.length > 0;
  const composerBlocked =
    !contextReady ||
    agentContextError !== null ||
    historyLoading ||
    historyError !== null ||
    !hasAgents;
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
    id: "workbench-panels",
    panelIds: ["chat", "files"],
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
          void steerOrQueue(sessionId, runId, text);
          return;
        }
        setQueued((q) => [...q, { id: crypto.randomUUID(), text, files: message.files }]);
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
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally use the current send closure
  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      void send(suggestion).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      running,
      input,
      contextReady,
      agentContextError,
      agentId,
      sessionId,
      historyLoading,
      historyError,
    ],
  );

  /**
   * 运行中追加一条消息(发送策略见 steer-client.ts)。
   * 只有明确"没受理 / 没送达"才改为本轮结束后作为新消息发送;不确定时绝不自动重发 ——
   * 那条可能已经交给了智能体,再发一遍就执行两次。
   */
  async function steerOrQueue(sid: string, runId: string, text: string) {
    const seq = openSeqRef.current;
    const r = await sendSteer({ sessionId: sid, runId, id: crypto.randomUUID(), text });
    if (seq !== openSeqRef.current) return;
    switch (r.kind) {
      case "delivered":
        toast.success("已交给智能体");
        return;
      case "pending":
        pendingSteerRef.current.add(r.id);
        toast.message("已提交,等待智能体接收");
        return;
      case "unconfirmed":
        // 结局若之后从事件流里来(未送达),照样会自动改为排队
        pendingSteerRef.current.add(r.id);
        toast.warning("暂时无法确认这条是否已交给智能体,请留意它的回答;确认没收到再重新发送");
        return;
      case "invalid":
        toast.error(r.message);
        return;
      case "resend":
        setQueued((q) => [...q, { id: crypto.randomUUID(), text, files: [] }]);
        toast.message("这一轮正在收尾,本轮结束后作为新消息发送");
        return;
    }
  }

  // 待定的追加消息最终没送达:改为排队,本轮结束后作为新消息发送
  useEffect(() => {
    for (const turn of turns) {
      for (const e of turn.events) {
        if (e.kind !== "steer" || e.outcome !== "dropped" || !e.id) continue;
        if (!pendingSteerRef.current.delete(e.id)) continue;
        setQueued((q) => [...q, { id: crypto.randomUUID(), text: e.text, files: [] }]);
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
  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      { name: "new", label: "新建会话", icon: Plus, disabled: running, run: newSession },
      { name: "search", label: "搜索会话和页面", icon: Command, run: () => setPaletteOpen(true) },
      { name: "agents", label: "管理智能体", icon: Bot, run: () => router.push("/agents") },
      {
        name: "stop",
        label: "停止当前运行",
        icon: X,
        disabled: !running,
        run: () => void cancelRun(),
      },
    ],
    [cancelRun, newSession, router, running],
  );
  const slashMenuOpen = /^\/[^\s]*$/.test(input);
  const slashQuery = slashMenuOpen ? input.slice(1).toLocaleLowerCase() : "";
  const matchingSlashCommands = slashMenuOpen
    ? slashCommands.filter((command) => command.name.startsWith(slashQuery))
    : [];
  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (command.disabled) return;
    setInput("");
    setSlashIndex(0);
    command.run();
  }, []);

  const pickAgent = (id: string) => {
    if (id === agentId || running) return;
    newSession();
    setAgentId(id);
    setAgentContextError(null);
    const url = new URL(window.location.href);
    url.searchParams.set("agent", id);
    url.searchParams.delete("session");
    window.history.replaceState(window.history.state, "", url);
  };
  const sessionList = (
    <>
      {sessionsError && (
        <div className="px-4 py-3 text-sm">
          <p className="text-destructive">会话列表加载失败：{sessionsError}</p>
          <Button variant="ghost" onClick={() => void loadSessions()}>
            重试
          </Button>
        </div>
      )}
      {!sessionsLoaded && <p className="px-4 py-3 text-sm text-muted-foreground">正在读取会话…</p>}
      <AgentTree
        agents={agents}
        sessions={sessions}
        activeAgentId={agentId}
        activeSessionId={sessionId}
        running={running}
        onPickAgentAction={pickAgent}
        onOpenSessionAction={(id) => void openSession(id)}
        onNewSessionAction={newSession}
        sessionActions={(session) => (
          <SessionActions
            session={session}
            onChanged={() => void loadSessions()}
            onRemoved={(id) => {
              setSessions((all) => all.filter((item) => item.id !== id));
              if (id === sessionId) {
                setRunning(false);
                openSeqRef.current += 1;
                pendingSteerRef.current.clear();
                abortRef.current?.abort();
                setSessionId(null);
                syncSessionUrl(null);
                setTurns([]);
                setQueued([]);
              }
            }}
          />
        )}
      />
    </>
  );

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChangeAction={setPaletteOpen}
        // 全部会话:命令面板是全局搜索,不该被当前智能体和侧栏搜索词收窄
        sessions={sessions}
        agents={agents}
        currentAgentId={agentId}
        running={running}
        onOpenSessionAction={(id) => void openSession(id)}
        onNewSessionAction={newSession}
        onPickAgentAction={pickAgent}
      />

      <IdeFrame
        onSearchAction={() => setPaletteOpen(true)}
        object={
          contextReady && !agentContextError && current
            ? {
                id: agentId,
                name: current.name,
                tab: "chat",
                sessionId,
                canReadConfig: current.canRead !== false,
              }
            : undefined
        }
        widgets={
          <Badge variant={running ? "success" : "outline"}>
            {running
              ? "运行中"
              : activeSession?.agentVersion
                ? `v${activeSession.agentVersion}`
                : !activeSession && current?.canWrite !== true && current?.publishedVersion
                  ? `已发布 v${current.publishedVersion}`
                  : "草稿"}
          </Badge>
        }
        toolWindow={{
          title: "智能体",
          body: sessionList,
        }}
      >
        {layoutReady ? (
          <ResizablePanelGroup
            className="min-h-0 flex-1"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            {/* 尺寸必须带单位:v4 把裸数字当像素 */}
            <ResizablePanel
              id="chat"
              defaultSize="74%"
              minSize="40%"
              className="workbench-chat-panel flex min-w-0 flex-col"
            >
              <div className="flex min-h-[70px] shrink-0 items-center gap-3 border-b border-border px-7 max-md:px-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">
                    {activeSession ? sessionLabel(activeSession) : "新会话"}
                  </h2>
                  <ModelPrice
                    model={shownModel}
                    className="truncate text-xs text-muted-foreground"
                  />
                </div>
                <button
                  type="button"
                  aria-label="查看执行详情"
                  title="查看执行详情"
                  aria-pressed={rightTab === "runs"}
                  onClick={() => toggleRight("runs")}
                  className={cn(
                    "flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent",
                    rightTab === "runs" && "bg-accent",
                  )}
                >
                  <ListTree className="size-[18px]" />
                </button>
                <button
                  type="button"
                  aria-label="打开工作空间"
                  title="打开工作空间"
                  aria-pressed={rightTab === "files"}
                  onClick={() => toggleRight("files")}
                  className={cn(
                    "flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent",
                    rightTab === "files" && "bg-accent",
                  )}
                >
                  <FolderOpen className="size-[18px]" />
                </button>
                <Sheet
                  open={mobileLayout && rightTab !== null}
                  onOpenChange={(open) => {
                    if (!open) setRightTab(null);
                  }}
                >
                  <SheetContent className="w-[92vw] gap-0 p-0" side="right">
                    <SheetTitle className="sr-only">
                      {rightTab === "runs" ? "执行详情" : "工作空间"}
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                      查看当前会话的文件或工具执行过程
                    </SheetDescription>
                    <div className="min-h-0 flex-1 pt-12">
                      {rightTab === "runs" ? (
                        <RunTree turns={turns} />
                      ) : (
                        <FilePanel sessionId={sessionId} refreshKey={filesKey} live={running} />
                      )}
                    </div>
                  </SheetContent>
                </Sheet>
              </div>

              <div
                data-conversation-shell=""
                className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden"
                onDragEnter={dropHandlers.onDragEnter as React.DragEventHandler}
                onDragOver={dropHandlers.onDragOver as React.DragEventHandler}
                onDragLeave={dropHandlers.onDragLeave as React.DragEventHandler}
                onDrop={dropHandlers.onDrop as React.DragEventHandler}
              >
                {/* 拖拽覆盖层 */}
                {dragActive && (
                  <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-primary/[0.035]">
                    <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-popover px-4 py-2 text-sm font-medium text-foreground shadow-lg">
                      松手添加文件
                    </div>
                  </div>
                )}

                {(() => {
                  const purgedAt = sessions.find((s) => s.id === sessionId)?.workspacePurgedAt;
                  return purgedAt ? (
                    <output className="mx-4 mt-3 block rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                      这个会话长期未活动,工作目录已于 {new Date(purgedAt).toLocaleString()}{" "}
                      自动清理,之前生成的文件已不在。对话记录还在;继续对话会在新的空目录里进行。
                    </output>
                  ) : null;
                })()}

                {/*
                  失败与"结局未知"由该轮自己的结果卡片展示。曾经顶部还有一条横幅显示同一段话,
                  同一个失败出现两遍。
                */}
                {/* 对话区域 */}
                {contextReady && !agentContextError && (
                  <VariablePrompt
                    key={`${agentId}-${sessionId ?? ""}`}
                    agentId={agentId}
                    sessionId={sessionId}
                  />
                )}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {agentContextError ? (
                    <output className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-destructive">
                      {agentContextError}
                    </output>
                  ) : historyLoading ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                      正在读取会话历史…
                    </div>
                  ) : historyError ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                      <AlertTriangle className="size-6 text-destructive" />
                      <p className="text-sm text-destructive">{historyError}</p>
                      {sessionId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void openSession(sessionId)}
                        >
                          <RefreshCw className="size-3.5" />
                          重试
                        </Button>
                      )}
                    </div>
                  ) : turns.length === 0 ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      {agentsState === "error" ? (
                        <div className="flex flex-col items-center gap-3 px-6 text-center">
                          <AlertTriangle className="size-6 text-destructive" />
                          <p className="text-sm text-destructive">智能体列表没读到</p>
                          <Button variant="outline" size="sm" onClick={loadAgents}>
                            <RefreshCw className="size-3.5" />
                            重试
                          </Button>
                        </div>
                      ) : agentsState === "ok" && !hasAgents ? (
                        // 没有任何可用智能体时,"发一句话试试"配一个禁用的输入框是自相矛盾的
                        <div className="flex flex-col items-center gap-3 px-6 text-center">
                          <MessageSquare className="size-12 text-muted-foreground/20" />
                          <h2 className="text-xl font-medium text-foreground">
                            还没有可用的智能体
                          </h2>
                          <p className="text-sm text-muted-foreground">
                            先创建一个智能体,或请管理员分享给你。
                          </p>
                          <Button size="sm" onClick={() => router.push("/agents")}>
                            新建智能体
                          </Button>
                        </div>
                      ) : (
                        <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                          <MessageSquare className="size-12 text-muted-foreground/20" />
                          <h2 className="text-xl font-medium text-foreground">
                            {current ? `和「${current.name}」开始对话` : "开始对话"}
                          </h2>
                          <p className="text-sm text-muted-foreground">
                            {current?.description ||
                              "描述你要它完成的事,它会在独立的工作目录里动手。"}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <ChatThread
                      key={sessionId ?? "new-session"}
                      agentName={current?.name}
                      turns={turns}
                      onRerunAction={stableRerunAction}
                      onAnswerAction={stableAnswerAction}
                      pendingQuestions={pendingQuestions}
                      submitAnswerAction={submitAnswerAction}
                    />
                  )}
                </div>

                <ApprovalBar
                  key={sessionId ?? "new"}
                  sessionId={sessionId}
                  running={running}
                  onQuestionsChange={setPendingQuestions}
                  refreshKey={approvalRefresh}
                />

                {/* 输入区占据独立高度,消息与提问在上方滚动,不会被输入框盖住。 */}
                <div className="z-20 shrink-0 py-3">
                  <div className="w-full px-3 sm:px-5">
                    <div className="pointer-events-auto mx-auto max-w-[850px]">
                      {contextReady &&
                        !agentContextError &&
                        turns.length === 0 &&
                        starters.length > 0 && (
                          <Suggestions className="pb-3">
                            {starters.map((text) => (
                              <Suggestion
                                key={text}
                                suggestion={text}
                                onClick={handleSuggestionClick}
                              />
                            ))}
                          </Suggestions>
                        )}
                      <div className="pb-4">
                        {slashMenuOpen && (
                          <SlashCommandMenu
                            commands={matchingSlashCommands}
                            activeIndex={Math.min(
                              slashIndex,
                              Math.max(0, matchingSlashCommands.length - 1),
                            )}
                            onSelect={selectSlashCommand}
                          />
                        )}
                        {queued.length > 0 && (
                          <ul className="mb-2 space-y-1" aria-label="排队中的消息">
                            {queued.map((q, i) => (
                              <li
                                key={q.id}
                                className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                              >
                                <span className="shrink-0 text-muted-foreground">排队 {i + 1}</span>
                                <span className="min-w-0 flex-1 truncate">{q.text}</span>
                                {q.files.length > 0 && (
                                  <span className="shrink-0 text-muted-foreground">
                                    {q.files.length} 个附件
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
                                  aria-label="取消这条排队消息"
                                  onClick={() =>
                                    setQueued((all) => all.filter((x) => x.id !== q.id))
                                  }
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <PromptInput globalDrop multiple onSubmit={handlePromptSubmit}>
                          {/* 没有附件时这一段是空的,但仍带着上内边距,会把占位文字往下顶 */}
                          <PromptInputHeader className="empty:hidden">
                            <AttachmentsDisplay />
                          </PromptInputHeader>
                          <PromptInputBody>
                            <PromptInputTextarea
                              aria-label="消息"
                              className="min-h-10"
                              value={input}
                              onChange={(event) => {
                                setInput(event.target.value);
                                setSlashIndex(0);
                              }}
                              onKeyDown={(event) => {
                                if (!slashMenuOpen || matchingSlashCommands.length === 0) return;
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  setSlashIndex(
                                    (index) => (index + 1) % matchingSlashCommands.length,
                                  );
                                } else if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  setSlashIndex(
                                    (index) =>
                                      (index - 1 + matchingSlashCommands.length) %
                                      matchingSlashCommands.length,
                                  );
                                } else if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  const command = matchingSlashCommands[slashIndex];
                                  if (command) selectSlashCommand(command);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setInput("");
                                }
                              }}
                              disabled={composerBlocked}
                              placeholder={
                                running
                                  ? "运行中也可以继续补充,会交给正在干活的智能体"
                                  : "说点什么,或输入 /"
                              }
                            />
                          </PromptInputBody>
                          {/*
                            左边是"往里加东西"(附件)和上下文用量,右边是"发出去"。
                            曾经三样东西用 justify-between 平分,附件按钮孤零零地落在正中间。
                          */}
                          <PromptInputFooter>
                            <PromptInputTools>
                              <PromptInputActionMenu>
                                <PromptInputActionMenuTrigger
                                  aria-label="添加附件"
                                  tooltip="添加附件"
                                />
                                <PromptInputActionMenuContent>
                                  <PromptInputActionAddAttachments label="添加图片或文件" />
                                </PromptInputActionMenuContent>
                              </PromptInputActionMenu>
                              {contextUsed > 0 && (
                                <ContextWindowMeter
                                  usedTokens={contextUsed}
                                  maxTokens={200_000}
                                  totalProcessed={totalProcessed}
                                />
                              )}
                            </PromptInputTools>
                            <div className="flex items-center gap-3">
                              <PromptInputSubmit
                                aria-label={running ? "停止运行" : "发送消息"}
                                title={running ? "停止运行" : "发送消息"}
                                className="size-11"
                                status={running ? "streaming" : "ready"}
                                onStop={cancelRun}
                                disabled={!running && composerBlocked}
                              />
                            </div>
                          </PromptInputFooter>
                        </PromptInput>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </ResizablePanel>

            {rightTab && !mobileLayout && (
              <>
                <ResizableHandle className="workbench-panel-handle" />
                <ResizablePanel
                  id="files"
                  defaultSize="24%"
                  minSize="16%"
                  maxSize="45%"
                  className="workbench-files-panel flex min-w-0 flex-col bg-sidebar"
                >
                  {/* 右侧工具窗口:工作空间与运行两个标签,和右侧工具窗口条上的两个图标对应 */}
                  <div className="flex h-9 shrink-0 items-stretch gap-3 border-b border-border px-3 text-sm">
                    {(
                      [
                        ["files", "工作空间"],
                        ["runs", "运行"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setRightTab(key)}
                        className={cn(
                          rightTab === key
                            ? "text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    <span className="flex-1" />
                    <button
                      type="button"
                      aria-label="收起工具窗口"
                      onClick={() => toggleRight(rightTab)}
                      className="my-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {rightTab === "files" ? (
                      <FilePanel sessionId={sessionId} refreshKey={filesKey} live={running} />
                    ) : (
                      <RunTree turns={turns} />
                    )}
                  </div>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        ) : (
          <div className="h-full w-full bg-background" aria-hidden="true" />
        )}
      </IdeFrame>
    </>
  );
}
