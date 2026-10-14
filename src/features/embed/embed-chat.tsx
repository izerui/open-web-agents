"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readEventStream } from "@/features/chat/event-stream";
import type { AgentEvent } from "@/lib/shared";
import { SendHorizontal, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Turn {
  prompt: string;
  events: AgentEvent[];
  running: boolean;
}

type QuestionEvent = Extract<AgentEvent, { kind: "question" }>;

/**
 * agent 的提问 —— widget 里也必须渲染成可点的选项。
 *
 * 【为什么不能不管】不渲染的话,agent 发出提问后界面上是一片空白:
 * 终端用户既不知道被问了什么,也不知道要答 —— 对话就此卡死。
 * 这里只做最小实现(按钮 + 全答完才能发),不引入工作台那套重组件。
 */
function QuestionBlock({
  e,
  answerable,
  onAnswer,
}: {
  e: QuestionEvent;
  answerable: boolean;
  onAnswer: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (cur.has(label)) cur.delete(label);
      else {
        if (!multi) cur.clear();
        cur.add(label);
      }
      return { ...prev, [qi]: cur };
    });
  };

  const answered = e.questions.map((_, i) => [...(picked[i] ?? [])]);
  const complete = answered.every((a) => a.length > 0);

  const submit = () => {
    if (!complete) return;
    // 多问一起答时带上标题,agent 才分得清哪个答案对哪个问题
    const text = e.questions
      .map((q, i) => {
        const ans = answered[i]?.join("、") ?? "";
        return e.questions.length > 1 ? `${q.header ?? q.question}:${ans}` : ans;
      })
      .join("\n");
    onAnswer(text);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      {e.questions.map((q, qi) => (
        <div key={`${q.question}-${qi}`} className="space-y-1.5">
          <p className="text-sm font-medium">{q.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const on = picked[qi]?.has(opt.label) ?? false;
              return (
                <Button
                  key={opt.label}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  disabled={!answerable}
                  title={opt.description}
                  onClick={() => toggle(qi, opt.label, q.multiSelect === true)}
                >
                  {opt.label}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      {answerable && (
        <Button type="button" size="sm" className="w-full" disabled={!complete} onClick={submit}>
          发送选择
        </Button>
      )}
    </div>
  );
}

/**
 * 把相邻的文字增量合成一段。
 *
 * 文字是按增量推送的(逐 token,编排层只做了短窗口合并),曾经每个事件渲染成一个独立段落,
 * 一句回答被拆成几十个碎块。工作台用 foldEvents 合并,这里做同样的事。
 */
function mergeText(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.kind === "text" && last?.kind === "text" && last.subagent === e.subagent) {
      out[out.length - 1] = { ...last, text: last.text + e.text };
    } else {
      out.push(e);
    }
  }
  return out;
}

/** widget 里只显示对用户有意义的内容 —— 工具细节与 token 用量属于运维视角,不该露给终端用户。 */
function Line({ e, streaming }: { e: AgentEvent; streaming: boolean }) {
  switch (e.kind) {
    case "text":
      // 子代理的中间文字是过程,不是给终端用户的回答
      if (e.subagent) return null;
      return (
        <div className="text-sm leading-relaxed">
          <MessageResponse isAnimating={streaming}>{e.text}</MessageResponse>
        </div>
      );
    case "status":
      // "已入队""运行中"这类是运维视角的内部状态,访客看到只会困惑;正在回复由光标表示
      if (e.state === "pending" || e.state === "running" || e.state === "knowledge") return null;
      return <p className="text-xs text-muted-foreground">{e.label}</p>;
    case "tool_use":
      return <p className="text-xs text-muted-foreground">正在使用 {e.tool}…</p>;
    case "result":
      if (e.status === "failed") {
        return <p className="text-sm text-destructive">出错了:{e.summary ?? "请稍后再试"}</p>;
      }
      if (e.status === "cancelled") {
        return <p className="text-sm text-muted-foreground">{e.summary ?? "运行已取消"}</p>;
      }
      // unknown 不能什么都不显示 —— 用户会以为消息发丢了。如实说明结局未知。
      if (e.status === "unknown") {
        return <p className="text-sm text-warning">{e.summary ?? "已提交,结果稍后可查"}</p>;
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
  const [expired, setExpired] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 新内容到达时跟到底部 —— 曾经回答一长就只能手动往下滚
  const lastLen = turns.at(-1)?.events.length ?? 0;
  useEffect(() => {
    if (turns.length > 0 || lastLen > 0) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, lastLen]);

  /** 停止:先让服务端真的停下(否则只是断开事件流,运行照常跑完扣费),再断开本地流。 */
  async function stop() {
    await fetch("/api/embed/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Embed-Token": token },
      body: "{}",
    }).catch(() => {});
    abortRef.current?.abort();
  }

  async function send(text?: string) {
    const prompt = (text ?? input).trim();
    if (!prompt || running || expired) return;
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
      const res = await fetch("/api/embed/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Embed-Token": token },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      });
      // 令牌过期/失效要给出明确提示,而不是让用户对着无反应的输入框发呆
      if (res.status === 401 || res.status === 403) {
        setExpired(
          res.status === 401 ? "会话已过期,请刷新页面重新开始" : "该助手已不可用,请联系网站管理员",
        );
        return;
      }
      // 其它错误(额度用尽、输入过长、服务端故障)的响应体是 JSON,不是事件流 ——
      // 曾经被当成事件流读完,一个字都不显示,这一轮静默结束
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        push({
          kind: "result",
          status: "failed",
          summary: data.error ?? `请求失败(HTTP ${res.status})`,
        });
        return;
      }
      if (!res.body) throw new Error("无响应流");
      await readEventStream(res.body, push);
    } catch (err) {
      if (abort.signal.aborted) {
        push({ kind: "result", status: "cancelled", summary: "已停止" });
      } else {
        push({
          kind: "result",
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
        });
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
              {mergeText(turn.events).map((e, j) =>
                e.kind === "question" ? (
                  <QuestionBlock
                    key={e.toolUseId ?? `q-${j}`}
                    e={e}
                    answerable={i === turns.length - 1 && !turn.running}
                    onAnswer={(t) => void send(t)}
                  />
                ) : (
                  <Line key={`${j}-${e.kind}`} e={e} streaming={turn.running} />
                ),
              )}
              {turn.running && (
                <p className="animate-pulse text-xs text-brand" aria-label="正在回复">
                  ▍
                </p>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} aria-live="polite" className="sr-only">
          {running ? "正在回复" : ""}
        </div>
      </div>

      {expired ? (
        <p className="border-t border-border p-4 text-center text-xs text-muted-foreground">
          {expired}
        </p>
      ) : (
        <div className="flex gap-2 border-t border-border p-3">
          <Input
            className="min-w-0 flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            // 中文输入法选字时的回车不能当成发送
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
            }}
            placeholder={running ? "正在回复…" : "输入消息"}
            disabled={running}
          />
          {running ? (
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={() => void stop()}
            >
              <Square className="size-4" />
              <span className="hidden sm:inline">停止</span>
            </Button>
          ) : (
            <Button
              type="button"
              className="shrink-0"
              onClick={() => void send()}
              disabled={!input.trim()}
            >
              <SendHorizontal className="size-4" />
              <span className="hidden sm:inline">发送</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
