"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalBar } from "./approval-bar";
import { CommandPalette } from "./command-palette";
import { ChatThread, contextTokens, formatTokens } from "./conversation";
import { FilePanel } from "./file-panel";
import { activityOf, groupSessions, relativeTime } from "./session-groups";
import type { AgentSummary, SessionSummary, Turn } from "./types";

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
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
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

/* ------------------------------------------------------------------ */
/*  附件展示子组件 — 在 PromptInput 内部使用 usePromptInputAttachments   */
/* ------------------------------------------------------------------ */
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
/*  Workbench                                                         */
/* ================================================================== */

export function Workbench() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState("default");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 打开会话的序号:用来丢弃"切走之后才回来"的过期响应。 */
  const openSeqRef = useRef(0);

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
    }
  }, []);

  useEffect(() => {
    void fetch("/api/agents")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { agents?: AgentSummary[] };
      })
      .then((d) => setAgents(d.agents ?? []))
      .catch((e: unknown) => {
        // 智能体拉不到不该连累会话列表 —— 原来两条链共用一个 effect 且都没 catch,
        // 任一失败都变成 unhandledRejection,两边一起空掉
        toast.error(`智能体列表加载失败:${e instanceof Error ? e.message : String(e)}`);
      });
    void loadSessions();
  }, [loadSessions]);

  const newSession = useCallback(() => {
    setSessionId(null);
    setTurns([]);
  }, []);

  /**
   * 中断 = 先告诉服务端取消,再断开本地流。
   *
   * 【只 abort 本地 fetch 是不够的】—— 运行不绑定在这个 HTTP 请求上(/run 的刻意设计)。
   * 光断本地流:界面显示已停止,而服务端 agent 继续调模型、继续执行工具、
   * 继续产生副作用与费用,直到 30 分钟墙钟上限。用户以为停了,其实没停。
   */
  const cancelRun = useCallback(async () => {
    if (sessionId) {
      await fetch(`/api/sessions/${sessionId}/cancel`, { method: "POST" }).catch(() => {});
    }
    abortRef.current?.abort();
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
    setRunning(false);

    const seq = ++openSeqRef.current;
    setSessionId(id);
    setTurns([]);
    setFilesKey((k) => k + 1);

    let history: { turns?: Turn[]; activeRunId?: string };
    try {
      const res = await fetch(`/api/sessions/${id}/history`);
      if (!res.ok) return;
      history = (await res.json()) as typeof history;
    } catch {
      // 历史拉不到就退回空白 —— 不该挡住用户接着发新的一轮
      return;
    }

    // 拉取期间用户可能又切走了。丢弃过期响应,否则上一个会话的历史会画到当前界面上。
    if (seq !== openSeqRef.current) return;
    setTurns(history.turns ?? []);

    const activeRunId = history.activeRunId;
    if (!activeRunId) return;

    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;

    // 【按 runId 定位而不是下标】下标会在并发/快速切换时错位,把事件灌进别的轮次。
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.runId === activeRunId ? fn(t) : t)));
    const push = (e: AgentEvent) => patch((t) => ({ ...t, events: [...t.events, e] }));

    try {
      const stream = await fetch(`/api/sessions/${id}/events`, { signal: abort.signal });
      if (stream.body) await readEventStream(stream.body, push);
    } catch (err) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(err) });
      }
    } finally {
      // 已经切到别的会话了就别再动状态 —— 那些 setState 针对的是已经不在屏幕上的数据
      if (seq === openSeqRef.current) {
        patch((t) => ({ ...t, running: false }));
        setRunning(false);
        abortRef.current = null;
        setFilesKey((k) => k + 1);
      }
    }
  }

  /**
   * 拿到可用的会话 id,没有就现建一个。
   *
   * 【为什么要校验返回体】这里原本直接解构 `{ session }` 就用 `session.id`:
   * 建会话失败(未登录、库挂了)时 session 是 undefined,下一行立刻 TypeError,
   * 而这个异常发生在发送流程内部 —— 用户点了发送,界面毫无反应,也没有任何提示。
   */
  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
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
  async function send(text?: string) {
    const prompt = (text ?? input).trim();
    if (!prompt || running) return;
    if (text === undefined) setInput("");
    setRunning(true);

    const idx = turns.length;
    setTurns((t) => [...t, { prompt, events: [], running: true }]);
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === idx ? fn(t) : t)));
    const push = (e: AgentEvent) => patch((t) => ({ ...t, events: [...t.events, e] }));

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const id = await ensureSession();
      const res = await fetch(`/api/sessions/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      });
      // 运行 id 从响应头带回,分支重跑要用它当分叉点
      const rid = res.headers.get("X-Run-Id");
      if (rid) patch((t) => ({ ...t, runId: rid }));
      if (!res.body) throw new Error("无响应流");
      await readEventStream(res.body, push);
    } catch (err) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(err) });
      }
    } finally {
      patch((t) => ({ ...t, running: false }));
      setRunning(false);
      abortRef.current = null;
      // 运行结束刷新文件面板,新产物立刻可见
      setFilesKey((k) => k + 1);
    }
  }

  /**
   * 重跑某一轮:入队一个【不 resume 的干净运行】,再挂上事件流看它跑。
   * 已有记录原样保留,不被覆盖。
   */
  async function rerun(fromRunId: string, prompt: string) {
    if (!sessionId || running) return;
    setRunning(true);

    const idx = turns.length;
    setTurns((t) => [...t, { prompt, events: [], running: true, branchedFrom: fromRunId }]);
    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t, i) => (i === idx ? fn(t) : t)));
    const push = (e: AgentEvent) => patch((t) => ({ ...t, events: [...t.events, e] }));

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/sessions/${sessionId}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromRunId, mode: "fresh", prompt }),
      });
      const d = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !d.runId) throw new Error(d.error ?? `HTTP ${res.status}`);
      patch((t) => ({ ...t, runId: d.runId }));

      // 分支已入队,挂上会话事件流观察 worker 执行
      const stream = await fetch(`/api/sessions/${sessionId}/events`, { signal: abort.signal });
      if (stream.body) await readEventStream(stream.body, push);
    } catch (err) {
      if (!abort.signal.aborted) {
        push({ kind: "result", status: "failed", summary: String(err) });
      }
    } finally {
      patch((t) => ({ ...t, running: false }));
      setRunning(false);
      abortRef.current = null;
      setFilesKey((k) => k + 1);
    }
  }

  const current = agents.find((a) => a.id === agentId);
  const sessionGroups = useMemo(() => groupSessions(sessions), [sessions]);
  const contextUsed = useMemo(() => contextTokens(turns), [turns]);

  // 记住用户拖出来的分栏宽度,下次进来还是这个宽度
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "workbench-panels",
    panelIds: ["chat", "files"],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  const handlePromptSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text) return;
      void send(text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, cancelRun, input],
  );

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      void send(suggestion);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, input],
  );

  return (
    <SidebarProvider className="h-screen min-h-0">
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={sessions}
        agents={agents}
        currentAgentId={agentId}
        running={running}
        onOpenSession={(id) => void openSession(id)}
        onNewSession={newSession}
        onPickAgent={(id) => {
          setAgentId(id);
          newSession();
        }}
      />

      {/* 侧边栏与其余页面共用 AppSidebar,只把智能体选择器和会话列表插进去 */}
      <AppSidebar
        headerExtra={
          <div className="space-y-2 group-data-[collapsible=icon]:hidden">
            <ModelSelector open={pickerOpen} onOpenChange={setPickerOpen}>
              <ModelSelectorTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between font-normal"
                  disabled={running}
                  title={running ? "运行中不能切换智能体" : "切换智能体"}
                >
                  <span className="truncate">{current?.name ?? agentId}</span>
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
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>

            <Button variant="outline" size="sm" className="w-full" onClick={newSession}>
              <Plus className="size-3.5" />
              新会话
            </Button>
          </div>
        }
      >
        {/* 以下作为 AppSidebar 的 children,挂在统一导航下面 */}
        <>
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

          {sessionsError === null && sessions.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center group-data-[collapsible=icon]:hidden">
              <MessageSquare className="size-5 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">还没有会话</p>
              <p className="text-[11px] text-muted-foreground/60">发一条消息就会创建一个</p>
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
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </>
      </AppSidebar>

      {/* 主区:对话 + 工作空间,可拖拽调宽并记忆 */}
      <SidebarInset className="min-w-0 overflow-hidden">
        <ResizablePanelGroup defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          {/* 尺寸必须带单位:v4 把裸数字当像素 */}
          <ResizablePanel
            id="chat"
            defaultSize="74%"
            minSize="40%"
            className="flex min-w-0 flex-col"
          >
            <div
              className={cn(
                "flex shrink-0 items-center gap-2.5 border-b border-border px-3 py-2.5 text-xs",
                running && "run-line",
              )}
            >
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="h-4" />
              <span className="font-medium text-foreground">{current?.name ?? agentId}</span>
              {current?.config.outputSchema && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  结构化输出
                </Badge>
              )}
              <Separator orientation="vertical" className="h-3" />
              <span className="truncate font-mono text-muted-foreground">
                {sessionId ? `${sessionId.slice(0, 8)}…` : "尚未创建会话"}
              </span>
              {/* 上下文占用 —— 长会话里最想知道的一个数,长到该开新会话时能提前察觉 */}
              {contextUsed > 0 && (
                <>
                  <Separator orientation="vertical" className="h-3" />
                  <span
                    className="shrink-0 font-mono text-muted-foreground"
                    title="最近一轮请求的输入 tokens ≈ 当前上下文装了多少内容"
                  >
                    上下文 {formatTokens(contextUsed)}
                  </span>
                </>
              )}

              {running && (
                <span className="flex shrink-0 items-center gap-1.5 text-brand">
                  <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                  运行中
                </span>
              )}

              {/* 快捷键本身不可发现,得留一个看得见的入口 */}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 shrink-0 gap-2 text-muted-foreground"
                onClick={() => setPaletteOpen(true)}
              >
                <Search className="size-3.5" />
                <span className="hidden sm:inline">搜索</span>
                <Kbd>⌘K</Kbd>
              </Button>
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col divide-y overflow-hidden">
              <Conversation className="min-h-0 flex-1">
                <ConversationContent className="px-4 py-4">
                  {turns.length === 0 ? (
                    <ConversationEmptyState
                      title="开始对话"
                      description="发一句话试试..."
                      icon={<MessageSquare className="size-12" />}
                    />
                  ) : (
                    <ChatThread
                      turns={turns}
                      onRerun={rerun}
                      onAnswer={(t: string) => void send(t)}
                    />
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              <ApprovalBar sessionId={sessionId} running={running} />

              <div className="grid shrink-0 gap-4 pt-4">
                {turns.length === 0 && (
                  <Suggestions className="px-4">
                    <Suggestion
                      suggestion="在工作目录写一个 hello.py"
                      onClick={handleSuggestionClick}
                    />
                    <Suggestion
                      suggestion="帮我分析这个项目的架构"
                      onClick={handleSuggestionClick}
                    />
                    <Suggestion
                      suggestion="创建一个简单的 REST API"
                      onClick={handleSuggestionClick}
                    />
                  </Suggestions>
                )}
                <div className="w-full px-4 pb-4">
                  <PromptInput globalDrop multiple onSubmit={handlePromptSubmit}>
                    <PromptInputHeader>
                      <AttachmentsDisplay />
                    </PromptInputHeader>
                    <PromptInputBody>
                      <PromptInputTextarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={running ? "运行中…" : "说点什么"}
                      />
                    </PromptInputBody>
                    <PromptInputFooter>
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
                      />
                    </PromptInputFooter>
                  </PromptInput>
                </div>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* 右栏:工作空间文件 */}
          <ResizablePanel
            id="files"
            defaultSize="21%"
            minSize="14%"
            maxSize="45%"
            className="panel-edge min-w-0 bg-card/40"
          >
            <FilePanel sessionId={sessionId} refreshKey={filesKey} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  );
}
