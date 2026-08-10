"use client";

import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { cn } from "@/lib/utils";
import { MessageSquare, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalBar } from "./approval-bar";
import { ChatThread } from "./conversation";
import { FilePanel } from "./file-panel";
import type { AssistantSummary, SessionSummary, Turn } from "./types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";

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
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";

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
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [assistantId, setAssistantId] = useState("default");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [filesKey, setFilesKey] = useState(0);
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
    <div className="flex h-screen">
      {/* 侧边栏:助手选择 + 会话列表 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Open Web Agents</span>
            <nav className="flex gap-1.5 text-xs">
              <a href="/builder" className="text-muted-foreground transition-colors hover:text-foreground">
                构建器
              </a>
              <a href="/groups" className="text-muted-foreground transition-colors hover:text-foreground">
                组
              </a>
              <a href="/usage" className="text-muted-foreground transition-colors hover:text-foreground">
                用量
              </a>
              <a href="/settings" className="text-muted-foreground transition-colors hover:text-foreground">
                设置
              </a>
            </nav>
          </div>
          <Select
            className="w-full text-xs"
            value={assistantId}
            onChange={(e) => {
              setAssistantId(e.target.value);
              newSession();
            }}
            disabled={running}
          >
            {assistants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.config.outputSchema ? " ·接口型" : ""}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={newSession}
          >
            <Plus className="size-3.5" />
            新会话
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={cn(
                "block w-full truncate px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-accent",
                s.id === sessionId && "bg-accent text-accent-foreground",
              )}
              onClick={() => void openSession(s.id)}
            >
              {s.title || s.id.slice(0, 12)}
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">暂无会话</p>
          )}
        </ScrollArea>
      </aside>

      {/* 主区:对话 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{current?.name ?? assistantId}</span>
          {current?.config.outputSchema && (
            <Badge variant="secondary">结构化输出</Badge>
          )}
          <Separator orientation="vertical" className="h-3" />
          <span>
            {sessionId ? `会话 ${sessionId.slice(0, 8)}…` : "(发送后创建会话)"}
          </span>
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
                <ChatThread turns={turns} onRerun={rerun} onAnswer={(t: string) => void send(t)} />
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
              <PromptInput
                globalDrop
                multiple
                onSubmit={handlePromptSubmit}
              >
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
      </main>

      {/* 右栏:工作空间文件 */}
      <aside className="w-80 shrink-0 border-l border-border">
        <FilePanel sessionId={sessionId} refreshKey={filesKey} />
      </aside>
    </div>
  );
}
