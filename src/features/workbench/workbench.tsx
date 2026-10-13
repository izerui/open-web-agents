"use client";

import { WorkbenchSidebar } from "@/components/workbench-sidebar";
import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { cn } from "@/lib/utils";
import type { FileUIPart } from "ai";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronsUpDown,
  Command,
  FolderOpen,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalBar } from "./approval-bar";
import { CommandPalette } from "./command-palette";
import { ContextWindowMeter } from "./context-window-meter";
import { ChatThread, contextTokens, sumUsage, totalUsageTokens } from "./conversation";
import { DesignBar } from "./design-bar";
import { createEventBatcher } from "./event-batcher";
import { FilePanel } from "./file-panel";
import { SessionActions } from "./session-actions";
import { activityOf, groupSessions, relativeTime } from "./session-groups";
import type { AgentSummary, SessionSummary, Turn } from "./types";
import {
  agentIdFromSearch,
  filterSessionsForAgent,
  sessionIdFromSearch,
  updateTurnByLocalId,
  withSessionInUrl,
} from "./workbench.logic";
import { makeWorkspaceFileDropHandlers } from "./workspace-file-drop";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  layoutStorage,
  useDefaultLayout,
} from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

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

/** 断线重连上限。超过就如实报「结局未知」—— 无限重试只会把已经出问题的服务端捶得更惨。 */
const MAX_RECONNECT = 5;

/**
 * 跟随一次运行的事件流,断线后按 Redis 游标续读。
 *
 * 【为什么要自己重连】fetch 不是 EventSource:它既不会自动重连,也不会自动带
 * Last-Event-ID。网络抖一下 readEventStream 就返回了,而运行还在 worker 里继续跑 ——
 * 界面却永远定格在断点,用户以为卡死,实际上后台早就跑完了。
 *
 * 【为什么不会重复渲染】服务端把 Redis Stream ID 写在 SSE 的 `id:` 字段里,
 * 续读时带上它,只会拿到这条之后的事件。
 *
 * 【收不到终态时发 unknown 而不是 failed】连不上只说明看不到过程,
 * 不代表运行失败 —— 运行不绑在这条 HTTP 上,它多半还在跑。
 */
async function followRun(args: {
  sessionId: string;
  runId: string;
  push: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** `/run` 返回的第一段流;重连场景不传。 */
  initial?: ReadableStream<Uint8Array> | null;
}): Promise<void> {
  const { sessionId, runId, push, signal } = args;
  let cursor = "0-0";
  let done = false;

  const onEvent = (e: AgentEvent) => {
    if (e.kind === "result") done = true;
    push(e);
  };
  const onCursor = (id: string) => {
    cursor = id;
  };

  if (args.initial) {
    try {
      await readEventStream(args.initial, onEvent, onCursor);
    } catch {
      // 第一段断了不要紧,下面按游标续
      if (signal.aborted) return;
    }
  }

  let lastError: unknown;
  for (let attempt = 0; !done && !signal.aborted && attempt <= MAX_RECONNECT; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 4000)));
      if (signal.aborted) return;
    }
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/events?runId=${encodeURIComponent(runId)}&cursor=${encodeURIComponent(cursor)}`,
        { signal, cache: "no-store" },
      );
      if (!res.ok) {
        throw await responseError(res, "重新连接运行失败");
      }
      if (!res.body) throw new Error("无响应流");
      await readEventStream(res.body, onEvent, onCursor);
      lastError = undefined;
    } catch (err) {
      if (signal.aborted) return;
      lastError = err;
    }
  }

  if (!done && !signal.aborted) {
    const why = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "";
    push({
      kind: "result",
      status: "unknown",
      summary: `连接中断${why ? `(${why})` : ""} —— 运行可能仍在后台继续,刷新页面可查看结果`,
      runId,
    });
  }
}

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

/** 内置"AI 智能体设计师"的 id(与 agent/domain/architect.ts 一致;前端不引服务端模块)。 */
const ARCHITECT_AGENT_ID = "agent-architect";

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
  const [filesKey, setFilesKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
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
  const [sessionQuery, setSessionQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<{ abort: AbortController; runId?: string } | null>(null);
  /** 打开会话的序号:用来丢弃"切走之后才回来"的过期响应。 */
  const openSeqRef = useRef(0);
  const initialSessionAppliedRef = useRef(false);

  const syncSessionUrl = useCallback((nextSessionId: string | null) => {
    const nextUrl = withSessionInUrl(window.location.href, nextSessionId);
    window.history.replaceState(window.history.state, "", nextUrl);
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
        setAgentId((currentId) => {
          // 从构建器"试运行"跳过来时 URL 带着 ?agent=,优先选中它
          const wanted = agentIdFromSearch(window.location.search);
          if (!currentId && wanted && nextAgents.some((agent) => agent.id === wanted)) {
            return wanted;
          }
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
    setQueued([]);
    abortRef.current?.abort();
    abortRef.current = null;
    activeRunRef.current = null;
    setSessionId(null);
    syncSessionUrl(null);
    setTurns([]);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [running, syncSessionUrl]);

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
    setQueued([]);
    const targetSession = sessions.find((session) => session.id === id);
    if (targetSession) setAgentId(targetSession.agentId);
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
    if (!sessionsLoaded || sessionsError !== null || initialSessionAppliedRef.current) return;
    initialSessionAppliedRef.current = true;
    const requestedSessionId = sessionIdFromSearch(window.location.search);
    if (requestedSessionId && sessions.some((session) => session.id === requestedSessionId)) {
      void openSession(requestedSessionId);
    } else if (requestedSessionId) {
      syncSessionUrl(null);
    }
  }, [sessions, sessionsError, sessionsLoaded, syncSessionUrl]);

  /**
   * 拿到可用的会话 id,没有就现建一个。
   *
   * 【为什么要校验返回体】这里原本直接解构 `{ session }` 就用 `session.id`:
   * 建会话失败(未登录、库挂了)时 session 是 undefined,下一行立刻 TypeError,
   * 而这个异常发生在发送流程内部 —— 用户点了发送,界面毫无反应,也没有任何提示。
   */
  async function ensureSession(firstPrompt: string): Promise<string> {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", {
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
    if (!prompt || running || historyLoading || historyError !== null) return;
    setRunning(true);

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
      const id = await ensureSession(prompt);
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
   * 重跑某一轮:入队一个【不 resume 的干净运行】,再挂上事件流看它跑。
   * 已有记录原样保留,不被覆盖。
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
      const res = await fetch(`/api/sessions/${targetSessionId}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromRunId, mode: "fresh", prompt }),
        signal: abort.signal,
      });
      const data = (await res.json().catch(() => null)) as {
        runId?: string;
        error?: string;
      } | null;
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

  const current = agents.find((a) => a.id === agentId);
  // 开场建议按智能体配置;曾经写死成编程示例,对"发票抽取"之类的智能体毫无意义
  const starters =
    current?.config.starters ?? (current?.id === "default" ? DEFAULT_AGENT_STARTERS : []);
  // 一个智能体都没有时,agentId 还是兜底的 "default",不能拿它当名字显示
  const hasAgents = agents.length > 0;
  const sessionsForAgent = useMemo(
    () => filterSessionsForAgent(sessions, agentId, ""),
    [agentId, sessions],
  );
  const visibleSessions = useMemo(
    () => filterSessionsForAgent(sessions, agentId, sessionQuery),
    [agentId, sessionQuery, sessions],
  );
  const sessionGroups = useMemo(() => groupSessions(visibleSessions), [visibleSessions]);
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
        setQueued((q) => [...q, { id: crypto.randomUUID(), text, files: message.files }]);
        toast.message("已排队,本轮结束后发送");
        return;
      }
      return send(text, message.files, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, cancelRun, input],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally use the current send closure
  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      void send(suggestion).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, input],
  );

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

  return (
    <SidebarProvider className="h-screen min-h-0">
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
        onPickAgentAction={(id) => {
          setAgentId(id);
          newSession();
        }}
      />

      {/* 侧栏只装工作台自己的东西:选哪个智能体、开新会话、我干过的活 */}
      <WorkbenchSidebar
        headerExtra={
          <div className="space-y-2 group-data-[collapsible=icon]:hidden">
            {/*
              这里只有"选哪个智能体",没有"去改智能体" —— 维护入口统一在
              侧栏底部的头像菜单里。曾经在选择器旁边挂过一个齿轮,
              头像菜单补上智能体入口后它就成了同一根侧栏里的第二个同去处。
            */}
            <ModelSelector open={pickerOpen} onOpenChange={setPickerOpen}>
              <ModelSelectorTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full min-w-0 justify-between font-normal"
                  disabled={running}
                  title={running ? "运行中不能切换智能体" : "切换智能体"}
                >
                  {/*
                    【为什么空了要单独说】agentId 的兜底值是 "default",一个智能体都
                    没有时这里会原样显示 "default" —— 看着像真有一个叫 default 的
                    智能体,而实际上一个都没建。
                  */}
                  <span className={cn("truncate", !hasAgents && "text-muted-foreground")}>
                    {hasAgents ? (current?.name ?? agentId) : "还没有智能体"}
                  </span>
                  <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="选择智能体">
                <ModelSelectorInput placeholder="搜索智能体…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>没有匹配的智能体</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="智能体">
                    {agents.map((a) => (
                      <ModelSelectorItem
                        key={a.id}
                        value={`${a.name} ${a.id}`}
                        onSelect={() => {
                          // 换智能体等于换一套系统提示与工具,继续用旧会话没有意义
                          setAgentId(a.id);
                          newSession();
                          setPickerOpen(false);
                        }}
                      >
                        <Check
                          className={cn("size-3.5", a.id === agentId ? "text-brand" : "opacity-0")}
                        />
                        <span className="flex-1 truncate">{a.name}</span>
                        {a.config.outputSchema && (
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                            接口型
                          </Badge>
                        )}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>

                  {/*
                    【为什么一个都没有时要单独给条出路】新账号打开工作台,
                    trigger 写着"还没有智能体",点开却是一份空列表 —— 去哪建
                    全靠自己猜。有智能体之后这条就撤了:那时它只是头像菜单里
                    「我的智能体」的重复。

                    【为什么值里不含"智能体"三个字】搜索是按 value 过滤的 ——
                    value 里带上常见词,用户搜某个智能体名字时这条会跟着被筛掉又出现,
                    位置飘忽。给一个不会被正常输入命中的哨兵值。
                  */}
                  {!hasAgents && (
                    <ModelSelectorItem
                      value="__create__"
                      onSelect={() => {
                        setPickerOpen(false);
                        router.push("/agents");
                      }}
                    >
                      <Plus className="size-3.5 text-muted-foreground" />
                      <span className="flex-1">新建第一个智能体…</span>
                    </ModelSelectorItem>
                  )}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={newSession}
              disabled={running}
              title={running ? "运行中不能新建会话" : "新建会话"}
            >
              <Plus className="size-3.5" />
              新会话
            </Button>
          </div>
        }
      >
        {/* 以下作为 WorkbenchSidebar 的 children —— 侧栏下半部分就是会话列表 */}
        <>
          <SidebarGroup className="sticky top-0 z-10 bg-sidebar pb-1 group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话"
                aria-label="搜索会话"
                className="h-8 bg-sidebar-accent/40 pl-8 pr-8 text-xs"
              />
              {sessionQuery && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="absolute right-0.5 top-0.5 size-7"
                  aria-label="清除会话搜索"
                  onClick={() => setSessionQuery("")}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          </SidebarGroup>
          {/* 【加载失败】与【一条都没有】必须分开:界面长得一样,含义完全相反 */}
          {sessionsError !== null && (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center group-data-[collapsible=icon]:hidden">
              <AlertTriangle className="size-5 text-destructive" />
              <p className="text-xs text-destructive">会话列表没读到</p>
              <p className="text-[11px] text-muted-foreground">
                历史还在,是这次请求失败了({sessionsError})
              </p>
              <Button variant="outline" size="sm" onClick={() => void loadSessions()}>
                <RefreshCw className="size-3.5" />
                重试
              </Button>
            </div>
          )}

          {/* 首次加载:骨架而不是"还没有会话" —— 两者长得一样,用户会以为历史丢了 */}
          {!sessionsLoaded && sessionsError === null && (
            <div className="space-y-2 px-3 py-3 group-data-[collapsible=icon]:hidden" aria-busy>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          )}

          {sessionsLoaded && sessionsError === null && sessionsForAgent.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center group-data-[collapsible=icon]:hidden">
              <MessageSquare className="size-5 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">还没有会话</p>
              <p className="text-[11px] text-muted-foreground/60">发一条消息就会创建一个</p>
            </div>
          )}

          {sessionsError === null &&
            sessionsForAgent.length > 0 &&
            visibleSessions.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                没有匹配的会话
              </div>
            )}

          {/* 按时间分档 —— 一列没有层次的标题里,人找不到"刚才那条" */}
          {sessionGroups.map(({ bucket, sessions: group }) => (
            <SidebarGroup key={bucket}>
              <SidebarGroupLabel>{bucket}</SidebarGroupLabel>
              <SidebarMenu>
                {group.map((s) => {
                  const active = s.id === sessionId;
                  const label = s.title || s.id.slice(0, 12);
                  // 【为什么还要挂 id】批量 invoke 建出来的会话标题会完全一样(清一色 "invoke"),
                  // 时间也挤在同一天 —— 只有 id 能区分是哪一条
                  const when = [
                    relativeTime(activityOf(s)),
                    s.runCount ? `${s.runCount} 轮` : null,
                    s.id.slice(0, 6),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <SidebarMenuItem key={s.id}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={`${label} · ${when}`}
                        onClick={() => void openSession(s.id)}
                        className="relative h-auto py-1.5 data-[active=true]:bg-sidebar-active data-[active=true]:text-sidebar-active-foreground"
                      >
                        {/* 选中指示条:全站唯一的强色锚点 */}
                        <span
                          className={cn(
                            "absolute left-0 top-1.5 bottom-1.5 w-0.5 origin-left rounded-r-full bg-brand transition-transform duration-200",
                            active ? "scale-x-100" : "scale-x-0",
                          )}
                        />
                        <MessageSquare
                          className={cn(
                            "shrink-0 transition-colors",
                            active ? "text-brand" : "text-muted-foreground/60",
                          )}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-xs leading-tight">{label}</span>
                          <span className="truncate text-[10px] leading-tight text-muted-foreground">
                            {when}
                          </span>
                        </span>
                        {active && running && (
                          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
                        )}
                      </SidebarMenuButton>
                      <SessionActions
                        session={s}
                        onChanged={() => void loadSessions()}
                        onRemoved={(removedId) => {
                          setSessions((all) => all.filter((x) => x.id !== removedId));
                          // 正打开着的会话被归档/删除了:回到空白新会话,而不是停在一个已不存在的会话上
                          if (removedId === sessionId) newSession();
                        }}
                      />
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </>
      </WorkbenchSidebar>

      {/* 主区:对话 + 工作空间,可拖拽调宽并记忆 */}
      <SidebarInset className="min-w-0 overflow-hidden">
        {layoutReady ? (
          <ResizablePanelGroup defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
            {/* 尺寸必须带单位:v4 把裸数字当像素 */}
            <ResizablePanel
              id="chat"
              defaultSize="74%"
              minSize="40%"
              className="workbench-chat-panel flex min-w-0 flex-col"
            >
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2.5 border-b border-border px-3 py-2.5 text-xs",
                  running && "run-line",
                )}
              >
                <SidebarTrigger className="-ml-1" />
                <Separator orientation="vertical" className="hidden h-4 sm:block" />
                <span className="hidden min-w-0 truncate font-medium text-foreground sm:block">
                  {current?.name ?? agentId}
                </span>
                {current?.config.outputSchema && (
                  <Badge
                    variant="secondary"
                    className="hidden h-5 px-1.5 text-[10px] font-normal sm:inline-flex"
                  >
                    结构化输出
                  </Badge>
                )}
                <Separator orientation="vertical" className="hidden h-3 sm:block" />
                <span className="hidden truncate font-mono text-muted-foreground sm:block">
                  {sessionId ? `${sessionId.slice(0, 8)}…` : "尚未创建会话"}
                </span>
                {running && (
                  <span className="flex shrink-0 items-center gap-1.5 text-brand">
                    <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                    <span className="hidden sm:inline">运行中</span>
                  </span>
                )}

                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto md:hidden"
                      aria-label="打开工作空间"
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent className="w-[92vw] gap-0 p-0" side="right">
                    <SheetTitle className="sr-only">工作空间</SheetTitle>
                    <SheetDescription className="sr-only">
                      浏览、预览和下载当前会话文件
                    </SheetDescription>
                    <FilePanel sessionId={sessionId} refreshKey={filesKey} live={running} />
                  </SheetContent>
                </Sheet>

                {/* 快捷键本身不可发现,得留一个看得见的入口 */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-2 text-muted-foreground md:ml-auto"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Search className="size-3.5" />
                  <span className="hidden sm:inline">搜索</span>
                  <Kbd>⌘K</Kbd>
                </Button>
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
                  <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]">
                    <div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg">
                      松手添加文件
                    </div>
                  </div>
                )}

                {sessionId && agentId === ARCHITECT_AGENT_ID && (
                  <DesignBar
                    key={sessionId}
                    sessionId={sessionId}
                    disabled={running}
                    onAskFix={stableAnswerAction}
                  />
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
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {historyLoading ? (
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
                      turns={turns}
                      onRerunAction={stableRerunAction}
                      onAnswerAction={stableAnswerAction}
                    />
                  )}
                </div>

                <ApprovalBar sessionId={sessionId} running={running} />

                {/* 输入区 — absolute 底部浮动（t3code 风格） */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
                  <div className="w-full px-3 sm:px-5">
                    <div className="pointer-events-auto mx-auto max-w-3xl">
                      {turns.length === 0 && starters.length > 0 && (
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
                          <PromptInputHeader>
                            <AttachmentsDisplay />
                          </PromptInputHeader>
                          <PromptInputBody>
                            <PromptInputTextarea
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
                              disabled={historyLoading || historyError !== null || !hasAgents}
                              placeholder={running ? "运行中…" : "说点什么,或输入 /"}
                            />
                          </PromptInputBody>
                          <PromptInputFooter>
                            {contextUsed > 0 ? (
                              <ContextWindowMeter
                                usedTokens={contextUsed}
                                // Claude's standard context window. Replace this
                                // with provider model metadata when available.
                                maxTokens={200_000}
                                totalProcessed={totalProcessed}
                              />
                            ) : (
                              <span />
                            )}
                            <PromptInputTools>
                              <PromptInputActionMenu>
                                <PromptInputActionMenuTrigger tooltip="添加附件" />
                                <PromptInputActionMenuContent>
                                  <PromptInputActionAddAttachments label="添加图片或文件" />
                                </PromptInputActionMenuContent>
                              </PromptInputActionMenu>
                            </PromptInputTools>
                            <PromptInputSubmit
                              status={running ? "streaming" : "ready"}
                              onStop={cancelRun}
                              disabled={
                                !running && (historyLoading || historyError !== null || !hasAgents)
                              }
                            />
                          </PromptInputFooter>
                        </PromptInput>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle className="workbench-panel-handle" />

            {/* 右栏:工作空间文件 */}
            <ResizablePanel
              id="files"
              defaultSize="21%"
              minSize="14%"
              maxSize="45%"
              className="workbench-files-panel panel-edge min-w-0 bg-card/40"
            >
              <FilePanel
                sessionId={mobileLayout ? null : sessionId}
                refreshKey={filesKey}
                live={running}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="h-full w-full bg-background" aria-hidden="true" />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
