"use client";

// 智能体设计器栏(编排阶段的主角):深色头、设计记录、对话、待确认的改动(按节应用 A4,挂在产生它的
// 那一轮回复下面,处理后原地留下「已应用到草稿 / 没有应用」)、差异与保存、legacy / conflict / aiIssue、
// 从试运行结果反馈(浮层)、各阶段之后的「下一步」提示、审批条、输入框。

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ApprovalBar } from "@/features/workbench/approval-bar";
import { ChatThread } from "@/features/workbench/conversation";
import type { Turn } from "@/features/workbench/types";
import { makeWorkspaceFileDropHandlers } from "@/features/workbench/workspace-file-drop";
import { formatTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  Image as ImageIcon,
  Info,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { trialFeedbackPrompt } from "./design-sections";
import {
  type NextStep,
  type NextTarget,
  type Outcome,
  needsRecharge,
  pendingAnchor,
} from "./designer-model";
import { ChangeBlock, DiffList } from "./diff-view";
import { SECTIONS } from "./profile-model";
import { Tag } from "./ui";
import type { Designer, TrialRun } from "./use-designer";

export type DesignerMode = "normal" | "wide" | "sheet";

const sectionTitle = (k: string) => SECTIONS.find((s) => s.key === k)?.title ?? k;

const EXAMPLES = [
  "把输出改成包含摘要和风险等级的 JSON",
  "加一条规则：金额超过 2 万元要财务总监审批",
  "开场建议写 3 条常见问题",
];

function recordLabel(r: { title?: string; createdAt?: number; id: string }) {
  const d = r.createdAt ? new Date(r.createdAt) : null;
  const date = d
    ? `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : "";
  return `${date} ${r.title?.replace(/^设计:/, "") ?? r.id}`.trim();
}

export function DesignerPanel({
  designer: g,
  mode,
  canWide,
  onToggleWide,
  onCollapse,
  targetName,
  next,
  onNext,
  onDismissNext,
}: {
  /** 各阶段之后的「下一步」提示(前端生成,不调模型) */
  next?: NextStep | null;
  onNext?: (to: NextTarget) => void;
  onDismissNext?: () => void;
  designer: Designer;
  mode: DesignerMode;
  /** 编排阶段才能展开成主画面 */
  canWide: boolean;
  onToggleWide?: () => void;
  onCollapse?: () => void;
  targetName: string;
}) {
  const v = g.view;
  const pendingCount = g.pending.reduce((n, p) => n + p.changes.length, 0);
  const lock = g.blocked || g.pending.length > 0;
  const [dialog, setDialog] = useState<"save" | "reset" | null>(null);
  const [token, setToken] = useState<string | undefined>();
  const [feedOpen, setFeedOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const canAttach = !v?.legacy;
  const addFiles = g.addFiles;
  const drop = useMemo(
    () => makeWorkspaceFileDropHandlers({ setDragActive, addFiles }),
    [addFiles],
  );
  const wide = mode === "wide";
  const anchor = pendingAnchor(g.turns);
  const inlinePending = anchor >= 0;

  /** 每一轮回复下面:这一轮改动的处理结果;最近一轮下面挂待确认的改动 */
  const renderTurnExtra = (t: Turn, i: number) => {
    const done = g.outcomes[t.runId ?? `turn-${i}`] ?? [];
    const showPending = i === anchor && g.pending.length > 0;
    if (!done.length && !showPending) return null;
    return (
      <div className="mt-2 flex flex-col gap-2 sm:pl-[42px]">
        {done.length > 0 && <OutcomeList items={done} />}
        {showPending && <PendingChanges designer={g} wide={false} inline />}
      </div>
    );
  };

  const openSave = async () => {
    await g.refresh();
    setToken(g.view?.previewToken);
    setDialog("save");
  };
  // 弹层打开期间预览变化:用最新的 token(按钮会随冲突/问题禁用)
  useEffect(() => {
    if (dialog === "save") setToken(v?.previewToken);
  }, [dialog, v?.previewToken]);

  return (
    <section
      aria-label="智能体设计器"
      onDragEnter={canAttach ? (drop.onDragEnter as React.DragEventHandler) : undefined}
      onDragOver={canAttach ? (drop.onDragOver as React.DragEventHandler) : undefined}
      onDragLeave={canAttach ? (drop.onDragLeave as React.DragEventHandler) : undefined}
      onDrop={canAttach ? (drop.onDrop as React.DragEventHandler) : undefined}
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden bg-[#F2F1EC]",
        mode === "sheet"
          ? "h-full"
          : "rounded-[18px] border border-[#D9D4C8] shadow-[0_6px_24px_rgba(40,35,25,.06)]",
        mode === "normal" && "w-[428px] shrink-0 2xl:w-[460px]",
        wide && "min-w-0 flex-1",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 bg-[#1F1E1C] py-3 pr-2 pl-3 text-white">
        <span className="rounded-full shadow-[0_0_0_2px_#3A3833]">
          <AgentAvatar id="agent-architect" size={34} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[17px] leading-tight font-bold">智能体设计器</div>
          <div className="truncate text-xs text-[#C9C4B8]">由 agent-architect 驱动</div>
        </div>
        <button
          type="button"
          onClick={() => void openSave()}
          disabled={!v || g.busy || v.legacy}
          title="查看全部待确认改动、冲突与校验问题"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-2xl border border-[#4A4842] px-2.5 text-[13px] whitespace-nowrap text-[#F2EFE7] hover:bg-[#34322D] disabled:opacity-50 max-md:h-11",
            pendingCount > 0 && "border-[#F2EFE7] bg-[#F2EFE7] text-[#1F1E1C] hover:bg-white",
          )}
        >
          <Layers className="size-[15px]" />
          差异与保存
          {pendingCount > 0 && (
            <b className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-[#B7791F] px-1 text-xs text-white">
              {pendingCount}
            </b>
          )}
        </button>
        {canWide && onToggleWide && (
          <button
            type="button"
            onClick={onToggleWide}
            aria-label={wide ? "收起设计器" : "展开设计器"}
            title={wide ? "收起设计器，回到档案编辑" : "展开设计器，放大对话"}
            className="grid size-[30px] shrink-0 place-items-center rounded-full text-[#E3DFD5] hover:bg-[#34322D] hover:text-white max-md:size-11"
          >
            {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
        {!wide && onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="收起到侧边"
            title="收起到侧边"
            className="grid size-[30px] shrink-0 place-items-center rounded-full text-[#E3DFD5] hover:bg-[#34322D] hover:text-white max-md:size-11"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-[#F6F5F1] px-3 py-2 max-md:flex-wrap">
        <label htmlFor="designer-record" className="shrink-0 text-[13px] text-muted-foreground">
          设计记录
        </label>
        <NativeSelect
          id="designer-record"
          aria-label="设计记录"
          className="h-8 min-w-0 flex-1 text-[13px] max-md:h-11 max-md:basis-[calc(100%-70px)]"
          value={g.sessionId}
          disabled={lock}
          title={
            g.blocked
              ? "设计器正在工作，稍后再切换"
              : g.pending.length
                ? "有待确认的改动，先应用或先不改"
                : "切换历史设计会话"
          }
          onChange={(e) => g.select(e.target.value)}
        >
          {!g.sessionId && <option value="">还没有设计记录</option>}
          {g.records.map((r) => (
            <option key={r.id} value={r.id}>
              {recordLabel(r)}
            </option>
          ))}
        </NativeSelect>
        <button
          type="button"
          disabled={lock}
          onClick={() => void g.create()}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] text-[#4D4A43] hover:bg-accent disabled:opacity-50 max-md:h-11"
        >
          <Plus className="size-3.5" />
          新建设计
        </button>
        <button
          type="button"
          aria-expanded={feedOpen}
          disabled={!g.sessionId || !v || v.legacy}
          onClick={() => setFeedOpen(!feedOpen)}
          title="把试运行结果反馈给设计器"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] text-[#4D4A43] hover:bg-accent disabled:opacity-50 max-md:h-11",
            feedOpen && "bg-accent font-medium",
          )}
        >
          <RefreshCw className="size-3.5" />
          试运行反馈
        </button>
      </div>
      {lock && !g.blocked && (
        <div className="flex shrink-0 items-center gap-1.5 bg-warning-soft px-3 py-1.5 text-xs text-warning-text">
          <Info className="size-3.5" />有 {g.pending.length}{" "}
          节待确认的改动，处理后才能切换或新建设计
        </div>
      )}
      {v?.conflict && !v.legacy && (
        <StateBox tone="warn">
          <b>目标智能体已被修改，当前设计不能直接覆盖。</b>
          <div>这段设计基于更早的草稿，之后草稿又改过。载入当前草稿后可以继续，对话保留。</div>
          <Button
            size="sm"
            className="mt-2"
            disabled={g.blocked}
            onClick={() => setDialog("reset")}
          >
            载入当前草稿
          </Button>
        </StateBox>
      )}
      {v?.legacy && (
        <StateBox tone="bad">
          <b>旧设计没有保存基线，不能继续发送消息。</b>
          <div>历史记录仍可查看；载入当前草稿后会建立基线，对话保留。</div>
          <Button
            size="sm"
            className="mt-2"
            disabled={g.blocked}
            onClick={() => setDialog("reset")}
          >
            载入当前草稿
          </Button>
        </StateBox>
      )}
      {v?.aiIssue && (
        <StateBox tone="bad">
          <b>设计器这一轮没有完成</b>
          <div>{v.aiIssue}</div>
          {g.turns.length > 0 && !v.legacy && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={g.blocked}
              onClick={() => void g.retry()}
            >
              <RotateCcw />
              重试
            </Button>
          )}
        </StateBox>
      )}
      {g.error && (
        <StateBox tone="bad" onClose={() => g.setError("")}>
          <div className="[overflow-wrap:anywhere]">{g.error}</div>
          {needsRecharge(g.error) && (
            <Link href="/account/billing?tab=packages" className="mt-1 inline-block underline">
              去充值
            </Link>
          )}
        </StateBox>
      )}

      <div className="relative flex min-h-[140px] flex-1 flex-col overflow-hidden">
        {!g.sessionId ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8 text-center">
            <AgentAvatar id="agent-architect" size={56} />
            <div className="mt-3 mb-1 font-display text-xl">用对话设计一个智能体</div>
            <p className="mt-0 mb-3.5 max-w-sm text-sm text-muted-foreground">
              说清楚要它做什么、按什么规则、要接哪些系统。设计器边问边改，每处改动先给你看差异，确认后才写进草稿。
            </p>
            <Button onClick={() => void g.create()} disabled={g.busy}>
              <Sparkles />
              开始新设计
            </Button>
            <div className="mt-3.5 flex flex-wrap justify-center gap-1.5">
              {EXAMPLES.map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => {
                    g.setPrompt(x);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px] hover:bg-[#F2F0EA]"
                >
                  {x}
                </button>
              ))}
            </div>
          </div>
        ) : g.loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-label="载入中" />
            正在载入设计记录…
          </div>
        ) : g.turns.length ? (
          <div className="min-h-0 flex-1">
            <ChatThread
              turns={g.turns}
              onAnswerAction={(text) => void g.send(text)}
              pendingQuestions={g.pendingQuestions}
              submitAnswerAction={g.submitAnswer}
              renderTurnExtra={renderTurnExtra}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
            {g.prompt.trim() && g.blocked
              ? "正在把你的描述交给设计器…"
              : "你想创建或调整怎样的智能体？说一句，设计器会先问清楚再动手。"}
          </div>
        )}
        {feedOpen && (
          <div className="absolute inset-x-3 bottom-2 z-30">
            <TrialFeedback
              designer={g}
              onClose={() => setFeedOpen(false)}
              onPick={(text) => {
                g.setPrompt(text);
                setFeedOpen(false);
                inputRef.current?.focus();
              }}
            />
          </div>
        )}
      </div>

      <div className="flex max-h-[45%] min-h-0 shrink flex-col overflow-y-auto">
        {(v?.issues?.length ?? 0) > 0 && (v?.changes?.length ?? 0) > 0 && (
          <div className="max-h-24 shrink-0 overflow-y-auto border-t border-line-soft bg-[#FDF6F4] px-3 py-1.5 text-xs text-destructive">
            <div className="font-semibold">校验问题，{v?.issues?.length} 处</div>
            {v?.issues?.map((i, n) => (
              <div key={`${i.field}-${n}`} className="[overflow-wrap:anywhere]">
                <span className="font-mono">{i.field}</span> {i.message}
              </div>
            ))}
          </div>
        )}

        {/* 没有对话轮次(比如只勾了 Skills / MCP 来源)时改动没处挂,放在输入框上方 */}
        {g.pending.length > 0 && !inlinePending && <PendingChanges designer={g} wide={wide} />}

        {next && !g.running && (
          <NextStepBar step={next} wide={wide} onNext={onNext} onDismiss={onDismissNext} />
        )}

        <div className={cn("shrink-0", wide && "mx-auto w-full max-w-[784px]")}>
          <ApprovalBar
            key={g.sessionId || "none"}
            sessionId={g.sessionId || null}
            running={g.running}
            onQuestionsChange={g.setPendingQuestions}
            refreshKey={g.approvalRefresh}
          />
        </div>
      </div>
      <div className={cn("shrink-0", wide && "mx-auto w-full max-w-[784px]")}>
        <form
          className={cn(
            "m-3 mt-1 rounded-[18px] border border-border bg-card px-3 pt-2.5 pb-2 shadow-[0_1px_2px_rgba(0,0,0,.03)]",
            v?.legacy && "opacity-60",
          )}
          onSubmit={(e) => {
            e.preventDefault();
            void g.sendInput();
          }}
        >
          {g.files.length > 0 && (
            <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="待发送的附件">
              {g.files.map((f) => (
                <li
                  key={f.name}
                  className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-border pr-0.5 pl-2 text-xs text-muted-foreground"
                >
                  {f.type.startsWith("image/") ? (
                    <ImageIcon className="size-3 shrink-0" />
                  ) : (
                    <FileIcon className="size-3 shrink-0" />
                  )}
                  <span className="max-w-48 truncate">{f.name}</span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${f.name}`}
                    disabled={g.blocked}
                    onClick={() => g.removeFile(f.name)}
                    className="flex size-6 items-center justify-center rounded-full hover:bg-[#DDD9CF] max-md:size-11"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Textarea
            ref={inputRef}
            aria-label="对智能体设计器说"
            value={g.prompt}
            disabled={v?.legacy}
            onChange={(e) => g.setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void g.sendInput();
              }
            }}
            placeholder="继续交代，比如：餐饮费每人每餐不超过 150 元"
            className="max-h-48 min-h-[52px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 max-md:text-base"
          />
          <div className="mt-1 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              aria-label="选择要交给设计器的文件"
              onChange={(e) => {
                g.addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={!canAttach || g.blocked}
              onClick={() => fileRef.current?.click()}
              title="添加业务文档，单个不超过 10MB，也可以直接拖进来"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[13px] text-[#4D4A43] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 max-md:size-11 max-md:justify-center max-md:px-0"
            >
              <Paperclip className="size-[15px]" />
              <span className="max-md:sr-only">添加文件</span>
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {g.pending.length
                ? `发送前会保留待确认的 ${g.pending.length} 节改动`
                : "改动先给你看差异，确认后写进草稿"}
            </span>
            {g.running ? (
              <button
                type="button"
                aria-label="停止"
                title="停止"
                disabled={g.busy}
                onClick={() => void g.stop()}
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground max-md:size-11"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="发送"
                disabled={g.blocked || (!g.prompt.trim() && !g.files.length) || v?.legacy}
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:bg-[#E3E0D8] disabled:text-[#57544D] max-md:size-11"
              >
                <ArrowUp className="size-4" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </form>
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-[rgb(247_246_242/88%)]">
          <div className="mx-4 rounded-3xl border-2 border-dashed border-[#9C978B] bg-card px-8 py-8 text-center">
            <Upload className="mx-auto size-8" />
            <p className="mt-3 mb-1 font-display text-[22px]">松手交给设计器</p>
            <p className="text-sm text-muted-foreground">
              单个文件不超过 10MB，发送时上传到这次设计的工作目录
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(o) => !o && g.working === null && setDialog(null)}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "reset" ? "载入目标智能体当前草稿" : "差异与保存"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "reset" ? (
                "当前设计草稿会被替换为智能体现在的内容，对话历史仍保留。"
              ) : (
                <>
                  把设计器提出、还没确认的改动一次写进「{targetName}」的草稿。
                  <b className="text-foreground">保存不会创建或切换发布版本。</b>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {dialog === "save" && (
            <>
              <DiffList changes={v?.changes ?? []} empty="设计器没有提出改动" />
              {v?.conflict && (
                <p className="m-0 text-sm text-destructive">
                  目标草稿已变化，不能覆盖；先载入当前草稿。
                </p>
              )}
              {(v?.issues?.length ?? 0) > 0 && (
                <div>
                  <div className="mb-1.5 text-sm font-semibold">校验问题，{v?.issues?.length}</div>
                  <div className="overflow-hidden rounded-xl border border-border">
                    {v?.issues?.map((i, n) => (
                      <div
                        key={`${i.field}-${n}`}
                        className="flex items-start gap-2 border-b border-line-soft px-3 py-2.5 text-sm last:border-0"
                      >
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        <span className="font-mono text-destructive">{i.field}</span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">{i.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <DialogFooter className="items-center">
            {dialog === "save" && (v?.conflict || (v?.issues?.length ?? 0) > 0) && (
              <span className="mr-auto text-xs text-muted-foreground">
                有冲突或校验问题时不能保存
              </span>
            )}
            <Button variant="outline" disabled={g.working !== null} onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              disabled={
                g.working !== null ||
                g.busy ||
                (dialog === "save" &&
                  (Boolean(v?.conflict) ||
                    (v?.issues?.length ?? 0) > 0 ||
                    !token ||
                    (v?.changes?.length ?? 0) === 0))
              }
              onClick={async () => {
                const ok = dialog === "reset" ? await g.resetToCurrent() : await g.applyAll(token);
                if (ok) setDialog(null);
              }}
            >
              <Check />
              {dialog === "reset" ? "确认载入" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function StateBox({
  tone,
  children,
  onClose,
}: {
  tone: "warn" | "bad";
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : undefined}
      className={cn(
        "mx-3 mt-2.5 flex shrink-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px]",
        tone === "warn"
          ? "bg-warning-soft text-warning-text"
          : "bg-destructive-soft text-destructive",
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && (
        <button type="button" aria-label="关闭错误提示" onClick={onClose} className="-m-1 p-1">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** 这一轮改动处理后的结果,留在对话里 */
function OutcomeList({ items }: { items: Outcome[] }) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((o) => (
        <div
          key={o.section}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[13px]"
        >
          <Tag line>{sectionTitle(o.section)}</Tag>
          <span className="text-muted-foreground">{o.count} 处改动</span>
          <span className="ml-auto">
            {o.applied ? (
              <Tag tone="ok">
                <Check />
                已应用到草稿
              </Tag>
            ) : (
              <Tag>没有应用</Tag>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 「下一步」提示条:按刚发生的事给去处按钮(前端生成,不调模型) */
function NextStepBar({
  step,
  wide,
  onNext,
  onDismiss,
}: {
  step: NextStep;
  wide: boolean;
  onNext?: (to: NextTarget) => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "rise-in mx-3 mb-1 flex shrink-0 items-start gap-2.5 rounded-[14px] border border-border bg-card px-3 py-2.5 shadow-[0_8px_24px_rgba(40,35,25,.08)]",
        wide && "mx-auto w-[min(760px,calc(100%-24px))]",
      )}
    >
      <AgentAvatar id="agent-architect" size={24} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-relaxed">{step.text}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {step.actions.map((a, i) => (
            <Button
              key={a.to}
              size="sm"
              variant={i === 0 ? "default" : "outline"}
              className="max-md:h-11"
              onClick={() => onNext?.(a.to)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="关闭提示"
          onClick={onDismiss}
          className="-m-1 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent max-md:size-11"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** 待确认的改动:按档案卡的节分组,每组「应用到草稿 / 先不改」(A4) */
function PendingChanges({
  designer: g,
  wide,
  inline,
}: {
  designer: Designer;
  wide: boolean;
  /** 挂在对话里那一轮回复下面 */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden rounded-[14px] border border-border bg-card",
        !inline && "mx-3 mb-1 shadow-[0_8px_24px_rgba(40,35,25,.08)]",
        wide && !inline && "mx-auto w-[min(760px,calc(100%-24px))]",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]"
      >
        {!inline && <AgentAvatar id="agent-architect" size={20} />}
        <b className="flex-1">设计器建议这样改，确认后写进草稿</b>
        <span className="text-muted-foreground">{g.pending.length} 节</span>
        <ChevronRight
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open && !g.view?.targetId && (
        <p className="m-0 border-t border-line-soft px-3 py-1.5 text-xs text-muted-foreground">
          还没有建好草稿：第一次应用时，名称与提示词会一起写进去，草稿随之建好。
        </p>
      )}
      {open && (
        <div className="border-t border-line-soft">
          {g.pending.map(({ section, changes }) => {
            const working = g.working === section;
            return (
              <div key={section} className="border-b border-line-soft last:border-0">
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                  <Tag tone="warn">{sectionTitle(section)}</Tag>
                  <span className="text-xs text-muted-foreground">{changes.length} 处改动</span>
                </div>
                <div className="mx-3 overflow-hidden rounded-xl border border-border">
                  {changes.map((c) => (
                    <ChangeBlock key={`${c.kind}:${c.path}`} c={c} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <Button
                    size="sm"
                    disabled={g.working !== null || g.blocked || g.view?.conflict || g.view?.legacy}
                    onClick={() => void g.applySection(section)}
                  >
                    {working ? <Loader2 className="animate-spin" /> : null}
                    应用到草稿
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={g.working !== null || g.blocked}
                    onClick={() => void g.rejectSection(section)}
                  >
                    先不改
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    应用不会创建或切换发布版本
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrialFeedback({
  designer: g,
  onClose,
  onPick,
}: {
  designer: Designer;
  onClose: () => void;
  onPick: (text: string) => void;
}) {
  const [runs, setRuns] = useState<TrialRun[] | null>(null);
  useEffect(() => {
    let live = true;
    void g.loadTrialRuns().then(
      (r) => live && setRuns(r),
      () => live && setRuns([]),
    );
    return () => {
      live = false;
    };
  }, [g.loadTrialRuns]);
  const label = (s: string) => (s === "success" ? "成功" : s === "failed" ? "失败" : "已取消");
  return (
    <div className="max-h-72 overflow-auto rounded-[14px] border border-border bg-card px-3 py-2.5 shadow-[0_12px_32px_rgba(40,35,25,.16)]">
      <div className="mb-1 flex items-center gap-2">
        <b className="text-[13px]">从试运行结果反馈</b>
        <span className="text-xs text-muted-foreground">选一条交给设计器</span>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="ml-auto grid size-8 place-items-center rounded-full hover:bg-accent max-md:size-11"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {runs === null ? (
        <p className="m-0 text-[13px] text-muted-foreground">载入中…</p>
      ) : runs.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">
          暂无试运行记录（试聊、评测、接口调用跑过一次后会出现在这里）
        </p>
      ) : (
        runs.map((r) => (
          <div
            key={r.runId}
            className="flex items-center gap-2 border-b border-line-soft py-2 text-[13px] last:border-0"
          >
            <Tag tone={r.status === "success" ? "ok" : r.status === "failed" ? "bad" : ""}>
              {label(r.status)}
            </Tag>
            <span className="min-w-0 flex-1 truncate">{r.promptPreview}</span>
            <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">
              {formatTime(r.at)}
            </span>
            <Button size="xs" variant="outline" onClick={() => onPick(trialFeedbackPrompt(r))}>
              反馈给设计器
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

/** 收起后的竖条 */
export function DesignerRail({ onOpen, pending }: { onOpen: () => void; pending: number }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="打开智能体设计器"
      title="打开智能体设计器"
      className="flex w-14 shrink-0 flex-col items-center gap-2.5 rounded-[18px] border border-border bg-[#F2F1EC] pt-3 hover:bg-[#ECEAE3]"
    >
      <ChevronRight className="size-[18px] text-muted-foreground" />
      <AgentAvatar id="agent-architect" size={30} />
      <span className="text-[13px] tracking-[2px] text-muted-foreground [writing-mode:vertical-rl]">
        智能体设计器
      </span>
      {pending > 0 && (
        <b className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-[#B7791F] px-1 text-xs text-white">
          {pending}
        </b>
      )}
    </button>
  );
}
