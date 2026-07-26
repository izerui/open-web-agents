"use client";

import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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

  async function send() {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput("");
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
          <Conversation turns={turns} />
        </div>

        <div className="flex gap-2 border-black/10 border-t p-3 dark:border-white/15">
          <input
            className="flex-1 rounded border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={running ? "运行中…" : "说点什么"}
            disabled={running}
          />
          {running ? (
            <button
              type="button"
              className="rounded bg-red-600 px-4 py-2 text-sm text-white"
              onClick={() => abortRef.current?.abort()}
            >
              中断
            </button>
          ) : (
            <button
              type="button"
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
              onClick={send}
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
