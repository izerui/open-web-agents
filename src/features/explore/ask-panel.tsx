"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { useAgentActions } from "@/features/market/market-actions";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatPerRun } from "@/lib/modules/market/domain/display";
import { cn } from "@/lib/utils";
import { ArrowUp, FileText, Paperclip, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { designerHref } from "./explore-logic";

const EXAMPLES = [
  "做一个审核报销单的助手，超过 5000 元提醒我",
  "整理今天的会议纪要",
  "给新耳机写一篇小红书文案",
  "比对两份合同的条款差异",
];

export interface SuggestItem {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  publishedVersion: number | null;
  author: string | null;
  avgCredits: number | null;
  mine: boolean;
}

type Result =
  | { state: "idle" }
  | { state: "loading"; text: string }
  | { state: "done"; text: string; items: SuggestItem[]; error?: string };

/** 「想交给它什么事？」:大输入框、示例问题,发送后给出推荐(gaps.md A1)。 */
export function AskPanel() {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  async function send(raw: string) {
    const q = raw.trim();
    if (!q) {
      toast.error("先写下想交给它的事");
      inputRef.current?.focus();
      return;
    }
    const mine = ++seq.current;
    setResult({ state: "loading", text: q });
    try {
      const data = await fetchJson<{ items: SuggestItem[] }>(
        `/api/market/suggest?q=${encodeURIComponent(q.slice(0, 200))}`,
      );
      if (mine === seq.current) setResult({ state: "done", text: q, items: data.items });
    } catch (error) {
      // 推荐失败也照样给出「让设计器做一个」:那一项不依赖推荐结果
      if (mine === seq.current) {
        setResult({ state: "done", text: q, items: [], error: errorText(error) });
      }
    }
  }

  return (
    <>
      <div className="w-full max-w-[780px] rounded-[22px] border border-border bg-card px-5 pt-4 pb-3 shadow-[0_8px_30px_rgb(60_50_30/5%)] focus-within:border-[#9C978B]">
        <textarea
          ref={inputRef}
          aria-label="想交给它什么事"
          placeholder="比如：做一个审核报销单的助手，超过 5000 元提醒我"
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
          className="h-14 w-full resize-none bg-transparent text-[17px] leading-relaxed outline-none placeholder:text-muted-foreground max-md:text-base"
        />
        <div className="flex items-center gap-2">
          {file && (
            <span className="inline-flex h-[30px] min-w-0 items-center gap-1.5 rounded-full bg-[#F2F0EA] pr-1 pl-2.5 text-[13px] text-[#3C3A35]">
              <FileText className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="max-w-40 truncate">{file.name}</span>
              <button
                type="button"
                aria-label="移除附件"
                className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-[#E4E1D9]"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            aria-label="选择文件"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              if (picked) toast.info("附件会在对话里上传：选好智能体、进入对话后再把文件拖进去");
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-md:h-11"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip />
            {file ? "换一个文件" : "添加文件"}
          </Button>
          <span className="text-xs text-muted-foreground max-md:hidden">
            回车发送，Shift＋回车换行
          </span>
          <button
            type="button"
            aria-label="发送"
            disabled={result.state === "loading"}
            onClick={() => void send(text)}
            className="ml-auto grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-black disabled:opacity-60 max-md:size-11"
          >
            <ArrowUp className="size-[18px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {result.state !== "idle" && <Suggestions result={result} file={file?.name ?? null} />}

      <div className="mt-4 flex max-w-[820px] flex-wrap justify-center gap-2">
        {EXAMPLES.map((t) => (
          <button
            key={t}
            type="button"
            className="inline-flex min-h-[34px] items-center rounded-full border border-border bg-card px-3.5 text-[13px] text-[#3C3A35] hover:border-[#BDB8AC] max-md:min-h-11 max-md:text-sm"
            onClick={() => {
              setText(t);
              void send(t);
            }}
          >
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

function Suggestions({
  result,
  file,
}: {
  result: Exclude<Result, { state: "idle" }>;
  /** 首页选的附件:会话建好之前没有地方放,只能进对话后再传,这里写明 */
  file: string | null;
}) {
  const { busy, start } = useAgentActions();
  return (
    <section
      aria-label="推荐"
      aria-live="polite"
      className="mt-3 w-full max-w-[780px] rounded-2xl border border-border bg-card p-2"
    >
      <div className="flex items-center gap-3.5 rounded-xl border border-[#E2DED3] bg-[#F4F2EC] px-4 py-3.5 max-sm:flex-wrap">
        <AgentAvatar id="agent-architect" size={48} />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[17px] font-bold">让智能体设计器做一个专门的</p>
          <p className="mt-0.5 text-sm text-[#4D4A43]">
            说清规则，设计器帮你配好模型、工具、知识和评测。这段描述会直接带进去。
          </p>
        </div>
        <Button asChild className="max-sm:h-11 max-sm:w-full">
          <Link href={designerHref(result.text)}>
            <Sparkles />
            用设计器创建
          </Link>
        </Button>
      </div>
      {result.state === "loading" ? (
        <p className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] text-muted-foreground">
          <span className="size-3.5 animate-spin rounded-full border-2 border-[#D9D5CB] border-t-foreground" />
          正在找合适的智能体…
        </p>
      ) : (
        <>
          <p className="px-3 pt-2 pb-0.5 text-[13px] text-muted-foreground">
            {result.error
              ? `推荐暂时不可用（${result.error}）`
              : result.items.length
                ? "或者先交给现成的智能体"
                : "市场里暂时没有直接对应的智能体"}
          </p>
          {file && (
            <p className="mx-3 mt-1.5 mb-1 rounded-lg bg-[#F6F5F1] px-3 py-2 text-[13px] text-[#4D4A43]">
              附件「{file}
              」不会自动带过去：进对话后再把文件拖进输入框；设计器不收附件，可以把要点写进描述。
            </p>
          )}
          {result.items.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[#F6F5F1] max-sm:flex-wrap"
            >
              <AgentAvatar id={a.id} icon={a.icon} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">交给「{a.name}」</p>
                <p className="line-clamp-2 text-[13px] text-muted-foreground">
                  {subline(a)}
                  {a.description ? `，${a.description}` : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className={cn("max-sm:h-11 max-sm:w-full")}
                disabled={busy !== null}
                onClick={() =>
                  void start(a.id, {
                    mode: a.mine ? "own" : "market",
                    question: result.text,
                    name: a.name,
                  })
                }
              >
                {busy === "start" ? "创建中…" : "立即使用"}
              </Button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function subline(a: SuggestItem): string {
  if (a.mine)
    return `你的智能体，${a.publishedVersion ? `已发布 v${a.publishedVersion}` : "还没发布"}`;
  const price = formatPerRun(a.avgCredits);
  return [a.author ? `${a.author} 发布` : "市场智能体", price].filter(Boolean).join("，");
}
