"use client";

import type { AgentEvent } from "@/lib/shared";
import { useRef, useState } from "react";
import { readEventStream } from "./event-stream";

interface Turn {
  prompt: string;
  events: AgentEvent[];
}

function EventLine({ e }: { e: AgentEvent }) {
  const tag = "subagent" in e && e.subagent ? `[${e.subagent}] ` : "";
  switch (e.kind) {
    case "text":
      return <p className="whitespace-pre-wrap text-sm">{e.text}</p>;
    case "thinking":
      return <p className="whitespace-pre-wrap text-sm italic opacity-50">{e.text}</p>;
    case "tool_use":
      return (
        <p className="font-mono text-xs opacity-70">
          {tag}▸ {e.tool}{" "}
          <span className="opacity-60">{JSON.stringify(e.input).slice(0, 160)}</span>
        </p>
      );
    case "tool_result":
      return (
        <pre
          className={`overflow-x-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10 ${
            e.isError ? "text-red-600" : "opacity-70"
          }`}
        >
          {e.text.slice(0, 600)}
        </pre>
      );
    case "status":
      return <p className="text-xs opacity-50">● {e.label}</p>;
    case "usage":
      return (
        <p className="text-xs opacity-40">
          tokens ↑{e.input} ↓{e.output}
        </p>
      );
    case "result":
      // unknown = 结局未知,既不是成功也不是失败(见 types.ts)
      return (
        <p
          className={`text-sm font-medium ${
            e.status === "success"
              ? "text-green-600"
              : e.status === "unknown"
                ? "text-amber-600"
                : "text-red-600"
          }`}
        >
          {e.status === "success" ? "✓ 完成" : e.status === "unknown" ? "⋯ 结局未知" : "✗ 失败"}
          {e.summary ? ` — ${e.summary}` : ""}
        </p>
      );
    default:
      return null;
  }
}

export function ChatView() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const res = await fetch("/api/sessions", { method: "POST" });
    const { session } = (await res.json()) as { session: { id: string } };
    setSessionId(session.id);
    return session.id;
  }

  async function send() {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput("");
    setRunning(true);

    const turnIndex = turns.length;
    setTurns((t) => [...t, { prompt, events: [] }]);

    const push = (e: AgentEvent) =>
      setTurns((t) =>
        t.map((turn, i) => (i === turnIndex ? { ...turn, events: [...turn.events, e] } : turn)),
      );

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
      setRunning(false);
      abortRef.current = null;
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="font-semibold text-xl">Open Web Agents</h1>
        <p className="text-xs opacity-50">
          会话 {sessionId ? `${sessionId.slice(0, 8)}…` : "(发送后创建)"} · 每个会话一个独立工作目录
        </p>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto">
        {turns.map((turn, i) => (
          <section key={`${i}-${turn.prompt}`} className="space-y-2">
            <p className="rounded bg-black/5 px-3 py-2 text-sm dark:bg-white/10">{turn.prompt}</p>
            <div className="space-y-1 pl-3">
              {turn.events.map((e, j) => (
                <EventLine key={`${j}-${e.kind}`} e={e} />
              ))}
            </div>
          </section>
        ))}
        {turns.length === 0 && (
          <p className="pt-8 text-center text-sm opacity-40">
            发一句话试试,比如「在工作目录建个 hello.txt 写上当前时间」
          </p>
        )}
      </div>

      <div className="flex gap-2">
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
  );
}
