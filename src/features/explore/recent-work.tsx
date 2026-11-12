"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import type { WorkStatus, WorkStep } from "@/lib/modules/session/domain/recent-work";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, Eye, FileText, MessageSquare, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type Tone, chatHref, workStatusLabel } from "./explore-logic";

interface RecentSession {
  id: string;
  title: string | null;
  agent: { id: string; name: string; icon: string | null };
  lastActiveAt: number;
  status: WorkStatus;
  lastRun: {
    status: string;
    prompt: string;
    reply: string | null;
    at: number;
    /** 正在工作时最近 3 条步骤(工具调用或计划);读不到事件流时为空或没有 */
    steps?: WorkStep[];
  } | null;
  file: { name: string; path: string; size: number | null } | null;
}

const BADGE: Record<Tone, "success" | "warning" | "destructive" | "default"> = {
  success: "success",
  warning: "warning",
  destructive: "destructive",
  muted: "default",
};

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success-text",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function sizeText(n: number | null): string | null {
  if (n === null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const titleOf = (s: RecentSession) => s.title || s.lastRun?.prompt || "新对话";

/** 「你的 AI 同事正在工作」:最近 5 个会话与各自最近一次运行的状态、交付物(gaps.md A2)。 */
export function RecentWork() {
  const [items, setItems] = useState<RecentSession[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [picked, setPicked] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 只用来重试
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void fetchJson<{ sessions: RecentSession[] }>("/api/sessions/recent", {
      signal: controller.signal,
    })
      .then((r) => {
        if (controller.signal.aborted) return;
        setItems(r.sessions);
        setPicked(0);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [refresh]);

  const count = items?.length ?? 0;

  return (
    <section
      className="bg-band px-20 py-12 max-lg:px-8 max-md:px-5 max-md:py-9"
      aria-labelledby="work-title"
    >
      <div className="flex items-end gap-4 max-md:flex-col max-md:items-start">
        <div className="min-w-0">
          <h2 id="work-title" className="font-display text-4xl font-bold max-md:text-[28px]">
            你的 AI 同事正在工作
          </h2>
          <p className="mt-1.5 text-base text-muted-foreground">
            {count
              ? `最近交给它们的 ${count} 件事。点开看过程，或者到对话里接着交代下一项。`
              : "交给它们的事会出现在这里。"}
          </p>
        </div>
        <Button variant="outline" asChild className="ml-auto max-md:ml-0 max-md:h-11">
          <Link href="/chat">
            <MessageSquare />
            全部会话
          </Link>
        </Button>
      </div>

      {error ? (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-[18px] border border-border bg-card px-6 py-5 text-[15px]">
          <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1">最近会话加载失败：{error}</span>
          <Button
            variant="outline"
            size="sm"
            className="max-md:h-11"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw />
            重试
          </Button>
        </div>
      ) : items === null ? (
        <div className="mt-6 grid min-h-[300px] grid-cols-[330px_1fr] rounded-[18px] border border-border bg-[#F4F3EE] max-md:grid-cols-1">
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-[14px] bg-[#ECEAE3]" />
            ))}
          </div>
          <div className="p-7 max-md:hidden">
            <div className="h-full animate-pulse rounded-[18px] bg-[#ECEAE3]" />
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-[18px] border border-border bg-card px-6 py-10 text-center">
          <p className="font-display text-[22px] font-bold">还没有交给它们的事</p>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            在上面说一件事，或者从下面的市场里挑一个智能体开始。
          </p>
        </div>
      ) : (
        <WorkBoard
          items={items}
          picked={Math.min(picked, items.length - 1)}
          onPickAction={setPicked}
        />
      )}
    </section>
  );
}

function WorkBoard({
  items,
  picked,
  onPickAction,
}: {
  items: RecentSession[];
  picked: number;
  onPickAction: (i: number) => void;
}) {
  const s = items[picked] as RecentSession;
  const status = workStatusLabel(s.status);
  return (
    <div className="mt-6 grid min-h-[420px] grid-cols-[330px_minmax(0,1fr)] max-md:min-h-0 rounded-[18px] border border-border bg-[#F4F3EE] max-lg:grid-cols-[280px_minmax(0,1fr)] max-md:grid-cols-1">
      <div className="border-r border-border px-5 py-[22px] max-md:border-r-0 max-md:border-b max-md:px-3 max-md:py-4">
        <p className="mb-2.5 ml-2.5 text-[13px] text-muted-foreground">
          最近 {items.length} 个会话
        </p>
        <ul className="space-y-1">
          {items.map((x, i) => {
            const label = workStatusLabel(x.status);
            return (
              <li key={x.id}>
                <button
                  type="button"
                  aria-current={i === picked ? "true" : undefined}
                  onClick={() => onPickAction(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[14px] border border-transparent p-2.5 text-left hover:bg-[#ECEAE3]",
                    i === picked &&
                      "border-border bg-card shadow-[0_1px_3px_rgb(0_0_0/5%)] hover:bg-card",
                  )}
                >
                  <AgentAvatar id={x.agent.id} icon={x.agent.icon} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{titleOf(x)}</span>
                    <span className="flex min-w-0 items-center gap-1 text-xs">
                      <StatusIcon status={x.status} />
                      <span className={cn("shrink-0", TONE_TEXT[label.tone])}>{label.label}</span>
                      <span className="ml-1.5 truncate text-muted-foreground">
                        {x.agent.name}，{formatTime(x.lastActiveAt)}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-7 max-md:p-3">
        <article className="flex h-full flex-col rounded-[18px] border border-border bg-card">
          <header className="flex items-center gap-2.5 border-b border-line-soft px-5 py-3.5 max-md:flex-wrap max-md:px-4">
            <AgentAvatar id={s.agent.id} icon={s.agent.icon} size={26} />
            <span className="min-w-0 flex-1 truncate font-medium">{titleOf(s)}</span>
            <div className="flex items-center gap-2.5 max-md:w-full max-md:justify-between">
              <Badge variant={BADGE[status.tone]}>{status.label}</Badge>
              <Button size="sm" asChild className="max-md:h-11">
                <Link href={chatHref(s.id)}>在对话里打开</Link>
              </Button>
            </div>
          </header>
          <div className="flex-1 px-[60px] py-5 max-lg:px-6 max-md:px-4">
            {s.lastRun ? (
              <>
                <p className="ml-auto w-fit max-w-[440px] rounded-[14px] bg-[#E9EEE9] px-4 py-2.5 text-[15px] break-words whitespace-pre-wrap">
                  {s.lastRun.prompt}
                </p>
                <div className="mt-4 flex items-start gap-2.5">
                  <AgentAvatar id={s.agent.id} icon={s.agent.icon} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 text-xs text-muted-foreground">{s.agent.name}</p>
                    <Reply s={s} />
                  </div>
                </div>
              </>
            ) : (
              <p className="text-[15px] text-muted-foreground">
                这个会话还没开始。到对话里交代第一件事。
              </p>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: WorkStatus }) {
  if (status === "running") {
    return (
      <span
        aria-hidden="true"
        className="size-[11px] shrink-0 animate-spin rounded-full border-[1.5px] border-[#D9D5CB] border-t-warning-text"
      />
    );
  }
  if (status === "delivered" || status === "replied") {
    return (
      <Check className="size-3 shrink-0 text-success-text" strokeWidth={2.4} aria-hidden="true" />
    );
  }
  return null;
}

const STEP_STATE: Record<WorkStep["state"], string> = {
  done: "已完成",
  running: "进行中",
  error: "出错",
  pending: "未开始",
};

/** 正在工作的步骤清单:已完成的打勾,当前步骤转圈(原型 .steps) */
function Steps({ steps }: { steps: WorkStep[] }) {
  return (
    <ol
      aria-label="最近的步骤"
      className="mt-2 flex flex-col gap-1.5 rounded-[14px] border border-border bg-card px-3.5 py-2.5"
    >
      {steps.map((step, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: 同一刻的步骤清单,标签可能重复
          key={i}
          className={cn(
            "flex items-center gap-2 text-[13px]",
            step.state === "done" ? "text-foreground" : "text-muted-foreground",
            step.state === "error" && "text-destructive",
          )}
        >
          {step.state === "running" ? (
            <span
              aria-hidden="true"
              className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-[#D9D5CB] border-t-foreground"
            />
          ) : step.state === "done" ? (
            <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          ) : step.state === "error" ? (
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-full border-[1.5px] border-[#D9D5CB]"
            />
          )}
          <span className="min-w-0 truncate">{step.label}</span>
          <span className="sr-only">（{STEP_STATE[step.state]}）</span>
        </li>
      ))}
    </ol>
  );
}

function Reply({ s }: { s: RecentSession }) {
  const reply = s.lastRun?.reply;
  const text = reply ? (
    <p className="line-clamp-6 text-[15px] break-words whitespace-pre-wrap">
      {reply}
      {reply.length >= 400 ? "…" : ""}
    </p>
  ) : null;

  if (s.status === "running") {
    return (
      <>
        {text ?? <p className="text-[15px] text-muted-foreground">正在处理这件事…</p>}
        {s.lastRun?.steps && s.lastRun.steps.length > 0 && <Steps steps={s.lastRun.steps} />}
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild className="max-md:h-11">
            <Link href={chatHref(s.id)}>
              <Eye />
              看执行过程
            </Link>
          </Button>
        </div>
      </>
    );
  }
  if (s.status === "delivered" && s.file) {
    return (
      <>
        {text}
        <div className="mt-2.5 rounded-[14px] border border-[#D3E2D6] bg-[#F3F7F3] px-4 py-3.5">
          <p className="flex items-center gap-1.5 font-medium text-success-text">
            <Check className="size-4" strokeWidth={2} aria-hidden="true" />
            成果已交付
          </p>
          <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 max-sm:flex-wrap">
            <FileText className="size-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{s.file.name}</p>
              {sizeText(s.file.size) && (
                <p className="text-xs text-muted-foreground">{sizeText(s.file.size)}</p>
              )}
            </div>
            <Button variant="outline" size="sm" asChild className="max-md:h-11">
              <Link href={chatHref(s.id)}>在对话里打开</Link>
            </Button>
          </div>
        </div>
      </>
    );
  }
  if (s.status === "failed" || s.status === "cancelled") {
    return (
      <>
        <p
          className={cn(
            "text-[15px]",
            s.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {s.status === "failed" ? "这次没有完成，出错了。" : "这次运行被停止了。"}
        </p>
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild className="max-md:h-11">
            <Link href={chatHref(s.id)}>
              <Eye />
              看执行过程
            </Link>
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      {text ?? <p className="text-[15px] text-muted-foreground">已回复。</p>}
      <div className="mt-3">
        <Button variant="outline" size="sm" asChild className="max-md:h-11">
          <Link href={chatHref(s.id)}>
            <MessageSquare />
            接着问
          </Link>
        </Button>
      </div>
    </>
  );
}
