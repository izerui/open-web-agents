"use client";

import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalBar } from "./approval-bar";
import { Conversation } from "./conversation";
import { FilePanel } from "./file-panel";
import type { AssistantSummary, SessionSummary, Turn } from "./types";

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/assistants")
      .then((r) => r.json())
      .then((d: { assistants?: AssistantSummary[] }) => setAssistants(d.assistants ?? []));
    void fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions?: SessionSummary[] }) => setSessions(d.sessions ?? []));
  }, []);

  // 新事件到达时贴底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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

  async function openSession(id: string) {
    setSessionId(id);
    setTurns([]);
    setFilesKey((k) => k + 1);
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

  return (
    <div className="flex h-screen">
      {/* 侧边栏:助手选择 + 会话列表 */}
      <aside className="flex w-60 shrink-0 flex-col border-black/10 border-r dark:border-white/15">
        <div className="space-y-2 border-black/10 border-b p-3 dark:border-white/15">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm">Open Web Agents</span>
            <span className="flex gap-2 text-xs">
              <Link href="/builder" className="underline opacity-60 hover:opacity-100">
                构建器
              </Link>
              <Link href="/groups" className="underline opacity-60 hover:opacity-100">
                组
              </Link>
              <Link href="/usage" className="underline opacity-60 hover:opacity-100">
                用量
              </Link>
              <Link href="/settings" className="underline opacity-60 hover:opacity-100">
                设置
              </Link>
            </span>
          </div>
          <select
            className="w-full rounded border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
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
          </select>
          <button
            type="button"
            className="w-full rounded bg-black/5 py-1 text-xs hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            onClick={newSession}
          >
            + 新会话
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`block w-full truncate px-3 py-2 text-left font-mono text-xs hover:bg-black/5 dark:hover:bg-white/10 ${
                s.id === sessionId ? "bg-black/5 dark:bg-white/10" : ""
              }`}
              onClick={() => void openSession(s.id)}
            >
              {s.title || s.id.slice(0, 12)}
            </button>
          ))}
          {sessions.length === 0 && <p className="p-3 text-xs opacity-40">暂无会话</p>}
        </div>
      </aside>

      {/* 主区:对话 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-black/10 border-b px-4 py-2 text-xs opacity-60 dark:border-white/15">
          {current?.name ?? assistantId}
          {current?.config.outputSchema && (
            <span className="ml-2 rounded bg-blue-500/15 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">
              结构化输出
            </span>
          )}
          <span className="ml-2 opacity-70">
            {sessionId ? `会话 ${sessionId.slice(0, 8)}…` : "(发送后创建会话)"}
          </span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Conversation turns={turns} onRerun={rerun} onAnswer={(t) => void send(t)} />
        </div>

        <ApprovalBar sessionId={sessionId} running={running} />

        <div className="flex gap-2 border-black/10 border-t p-3 dark:border-white/15">
          <input
            className="flex-1 rounded border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void send()}
            placeholder={running ? "运行中…" : "说点什么"}
            disabled={running}
          />
          {running ? (
            <button
              type="button"
              className="rounded bg-red-600 px-4 py-2 text-sm text-white"
              onClick={cancelRun}
            >
              中断
            </button>
          ) : (
            <button
              type="button"
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
              onClick={() => void send()}
              disabled={!input.trim()}
            >
              发送
            </button>
          )}
        </div>
      </main>

      {/* 右栏:工作空间文件 */}
      <aside className="w-80 shrink-0 border-black/10 border-l dark:border-white/15">
        <FilePanel sessionId={sessionId} refreshKey={filesKey} />
      </aside>
    </div>
  );
}
