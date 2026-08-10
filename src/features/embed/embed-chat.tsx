"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { SendHorizontal } from "lucide-react";
import { useRef, useState } from "react";

interface Turn {
  prompt: string;
  events: AgentEvent[];
  running: boolean;
}

/** widget 里只显示对用户有意义的内容 —— 工具细节与 token 用量属于运维视角,不该露给终端用户。 */
function Line({ e }: { e: AgentEvent }) {
  switch (e.kind) {
    case "text":
      return <p className="whitespace-pre-wrap text-sm leading-relaxed">{e.text}</p>;
    case "status":
      return <p className="text-xs text-muted-foreground">{e.label}</p>;
    case "tool_use":
      return <p className="text-xs text-muted-foreground">正在使用 {e.tool}…</p>;
    case "result":
      if (e.status === "failed") {
        return <p className="text-sm text-destructive">出错了:{e.summary ?? "请稍后再试"}</p>;
      }
      // unknown 不能什么都不显示 —— 用户会以为消息发丢了。如实说明结局未知。
      if (e.status === "unknown") {
        return (
          <p className="text-sm text-[var(--warning)]">{e.summary ?? "已提交,结果稍后可查"}</p>
        );
      }
      return null;
    default:
      return null;
  }
}

/**
 * 可嵌入的对话组件。
 * 只持有短时效嵌入令牌 —— 企业的 API Key 留在他们自己的后端,永不进浏览器。
 */
export function EmbedChat({ token }: { token: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [expired, setExpired] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    const prompt = input.trim();
    if (!prompt || running || expired) return;
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
      const res = await fetch("/api/embed/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Embed-Token": token },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      });
      // 令牌过期要给出明确提示,而不是让用户对着无反应的输入框发呆
      if (res.status === 401) {
        setExpired(true);
        return;
      }
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
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <p className="pt-8 text-center text-sm text-muted-foreground">有什么可以帮你的?</p>
        )}
        {turns.map((turn, i) => (
          <div key={`${i}-${turn.prompt.slice(0, 16)}`} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-sm">
              {turn.prompt}
            </p>
            <div className="space-y-1">
              {turn.events.map((e, j) => (
                <Line key={`${j}-${e.kind}`} e={e} />
              ))}
              {turn.running && <p className="animate-pulse text-xs text-brand">▍</p>}
            </div>
          </div>
        ))}
      </div>

      {expired ? (
        <p className="border-t border-border p-4 text-center text-xs text-muted-foreground">
          会话已过期,请刷新页面重新开始
        </p>
      ) : (
        <div className="flex gap-2 border-t border-border p-3">
          <Input
            className="min-w-0 flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={running ? "正在回复…" : "输入消息"}
            disabled={running}
          />
          <Button type="button" className="shrink-0" onClick={send} disabled={!input.trim() || running}>
            <SendHorizontal className="size-4" />
            <span className="hidden sm:inline">发送</span>
          </Button>
        </div>
      )}
    </div>
  );
}
