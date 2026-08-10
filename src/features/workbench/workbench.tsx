"use client";

import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Check,
  ChevronsUpDown,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalBar } from "./approval-bar";
import { CommandPalette } from "./command-palette";
import { ChatThread } from "./conversation";
import { FilePanel } from "./file-panel";
import { groupSessions, relativeTime } from "./session-groups";
import type { AssistantSummary, SessionSummary, Turn } from "./types";

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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
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

const NAV_ITEMS = [
  { href: "/builder", label: "构建器", icon: Wrench },
  { href: "/groups", label: "组", icon: Users },
  { href: "/usage", label: "用量", icon: BarChart3 },
  { href: "/settings", label: "设置", icon: Settings },
] as const;

/* ================================================================== */
/*  Workbench                                                         */
/* ================================================================== */

export function Workbench() {
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [assistantId, setAssistantId] = useState("default");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [filesKey, setFilesKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** 打开会话的序号:用来丢弃"切走之后才回来"的过期响应。 */
  const openSeqRef = useRef(0);

  useEffect(() => {
    void fetch("/api/assistants")
      .then((r) => r.json())
      .then((d: { assistants?: AssistantSummary[] }) => setAssistants(d.assistants ?? []));
    void fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions?: SessionSummary[] }) => setSessions(d.sessions ?? []));
  }, []);

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

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assistantId }),
    });
    const { session } = (await res.json()) as { session: SessionSummary };
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

  const current = assistants.find((a) => a.id === assistantId);
  const sessionGroups = useMemo(() => groupSessions(sessions), [sessions]);

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
        assistants={assistants}
        currentAssistantId={assistantId}
        running={running}
        onOpenSession={(id) => void openSession(id)}
        onNewSession={newSession}
        onPickAssistant={(id) => {
          setAssistantId(id);
          newSession();
        }}
      />

      {/* 侧边栏:助手选择 + 会话列表。Cmd/Ctrl+B 折叠,移动端自动变抽屉 */}
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-2 border-b border-sidebar-border">
          <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-primary-foreground">
              A
            </span>
            <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
              Open Web Agents
            </span>
          </div>

          <div className="space-y-2 group-data-[collapsible=icon]:hidden">
            <ModelSelector open={pickerOpen} onOpenChange={setPickerOpen}>
              <ModelSelectorTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between font-normal"
                  disabled={running}
                  title={running ? "运行中不能切换助手" : "切换助手"}
                >
                  <span className="truncate">{current?.name ?? assistantId}</span>
                  <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="选择助手">
                <ModelSelectorInput placeholder="搜索助手…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>没有匹配的助手</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="助手">
                    {assistants.map((a) => (
                      <ModelSelectorItem
                        key={a.id}
                        value={`${a.name} ${a.id}`}
                        onSelect={() => {
                          // 换助手等于换一套系统提示与工具,继续用旧会话没有意义
                          setAssistantId(a.id);
                          newSession();
                          setPickerOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "size-3.5",
                            a.id === assistantId ? "text-brand" : "opacity-0",
                          )}
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
        </SidebarHeader>

        <SidebarContent>
          {sessions.length === 0 && (
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
                  // 【为什么时间旁边还要挂 id】批量 invoke 建出来的会话标题会完全一样
                  // (清一色 "invoke"),连创建时间都落在同一天 —— 只有 id 能区分是哪一条
                  const when = `${relativeTime(s.createdAt)} · ${s.id.slice(0, 6)}`;
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
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border">
          <SidebarMenu>
            {NAV_ITEMS.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild size="sm" tooltip={item.label}>
                  <a href={item.href}>
                    <item.icon />
                    <span className="text-xs">{item.label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

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
              <span className="font-medium text-foreground">{current?.name ?? assistantId}</span>
              {current?.config.outputSchema && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  结构化输出
                </Badge>
              )}
              <Separator orientation="vertical" className="h-3" />
              <span className="truncate font-mono text-muted-foreground">
                {sessionId ? `${sessionId.slice(0, 8)}…` : "尚未创建会话"}
              </span>
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
