"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { AskedQuestion } from "@/lib/shared";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { shouldNotifyQuestion } from "./workbench.logic";

const NARROW = "(max-width: 767px)";

/** 窄屏(手机):审批卡默认收成一行 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** 对话里这条提问的卡片是否在视口里(虚拟列表没渲染出来也算看不到) */
function questionCardInView(toolUseId: string | undefined): boolean {
  if (!toolUseId) return false;
  const el = document.querySelector(`[data-question-tool="${CSS.escape(toolUseId)}"]`);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.height > 0;
}

interface Pending {
  id: string;
  toolName: string;
  summary: string;
  reason: string;
  /** 所属的全部类别;有才能"本会话内同类不再询问"(授权的是全部这些类) */
  scopes?: { key: string; label: string }[];
  createdAt?: number;
  expiresAt: number;
  /** 有这项是智能体在提问(在对话里的提问卡片上作答),不是审批 */
  questions?: AskedQuestion[];
  toolUseId?: string;
}

/** 待回答的提问:交给对话里的提问卡片作答 */
export type PendingQuestion = Pending & { questions: AskedQuestion[] };

/** 本会话的同类授权 */
interface Grant {
  key: string;
  label: string;
}

/** 10 分钟的窗口显示成 "600s" 没法读,超过一分钟就用 mm:ss。 */
function formatLeft(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 待审批条。运行中轮询待审列表 —— agent 已经挂起在等裁决,
 * 界面必须让人看得到、点得了,否则只会等到超时自动拒。
 */
export function ApprovalBar({
  sessionId,
  running,
  onQuestionsChange,
  onApprovalsChange,
  refreshKey,
}: {
  sessionId: string | null;
  running: boolean;
  /** 待确认审批的工具名(会话列表标「待你确认」、对话流里对应调用标「等你确认」) */
  onApprovalsChange?: (toolNames: string[]) => void;
  /** 待回答的提问(与审批同一个通道,但在对话里的提问卡片上作答) */
  onQuestionsChange?: (questions: PendingQuestion[]) => void;
  /** 变化时立刻重新拉取(提问卡片作答后) */
  refreshKey?: number;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  /** 正在填拒绝说明的那条 */
  const [denying, setDenying] = useState<{ id: string; text: string } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 窄屏下展开了的审批卡 */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const narrow = useNarrow();
  /** 自己裁决过的待审 id:之后它从列表里消失不算超时 */
  const decidedRef = useRef<Set<string>>(new Set());
  /**
   * 【为什么倒计时要自己的 tick】剩余时间原本是在渲染时用 Date.now() 算的,
   * 而重渲染只由 2 秒一次的轮询触发 —— 跳着走。更糟的是运行一结束就不再轮询,
   * 倒计时直接冻在最后一次的数字上,而后端仍在正常倒数到自动拒绝。
   */
  const [now, setNow] = useState(() => Date.now());
  /** 已经弹过 toast 的待审 id —— 轮询每 2 秒回来一次,不能重复弹。 */
  const notifiedRef = useRef<Map<string, Pending>>(new Map());
  const mountedRef = useRef(true);
  const pollSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollSeqRef.current += 1;
    };
  }, []);

  const poll = useCallback(async () => {
    if (!sessionId || !mountedRef.current) return;
    const seq = ++pollSeqRef.current;
    try {
      const data = await fetchJson<{ pending?: Pending[]; grants?: Grant[] }>(
        `/api/sessions/${sessionId}/approvals`,
      );
      if (seq !== pollSeqRef.current || !mountedRef.current) return;
      setPending(data.pending ?? []);
      setGrants(data.grants ?? []);
      setPollError(null);
    } catch (error) {
      if (seq === pollSeqRef.current && mountedRef.current) setPollError(errorText(error));
    }
  }, [sessionId]);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const approvals = pending.filter((p) => !p.questions?.length);
  const questionsKey = pending
    .filter((p) => p.questions?.length)
    .map((p) => p.id)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在待回答的集合变化时通知
  useEffect(() => {
    onQuestionsChange?.(pending.filter((p): p is PendingQuestion => Boolean(p.questions?.length)));
  }, [questionsKey, onQuestionsChange]);
  const approvalTools = approvals.map((p) => p.toolName).join("\n");
  useEffect(() => {
    onApprovalsChange?.(approvalTools ? approvalTools.split("\n") : []);
  }, [approvalTools, onApprovalsChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重新拉取
  useEffect(() => {
    if (refreshKey) void poll();
  }, [refreshKey]);

  useEffect(() => {
    if (!sessionId) {
      setPending([]);
      setGrants([]);
      setPollError(null);
      return;
    }
    void poll();
    // 本地流结束但待审仍在时也继续轮询，直到裁决或服务端超时移除。
    if (!running && pending.length === 0) return;
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [sessionId, running, pending.length, poll]);

  // 有待审时才每秒走一次,没有就不空转
  useEffect(() => {
    if (pending.length === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  const decide = useCallback(
    async (
      id: string,
      decision: "approved" | "denied",
      extra: { remember?: "session"; message?: string } = {},
    ) => {
      if (!sessionId) return;
      setBusy(id);
      try {
        await fetchJson(`/api/sessions/${sessionId}/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: id, decision, ...extra }),
        });
        if (!mountedRef.current) return;
        decidedRef.current.add(id);
        const target = pendingRef.current.find((p) => p.id === id);
        if (decision === "approved") {
          toast.success(
            extra.remember
              ? `已批准，本会话内 ${target?.scopes?.map((s) => s.label).join("、") || "同类调用"} 不再询问（可随时撤销）`
              : "已批准",
          );
        } else {
          toast(extra.message ? "已拒绝，原因已交给智能体" : "已拒绝");
        }
        // 立刻从本地列表里去掉这张卡,不等下一次轮询
        setPending((all) => all.filter((p) => p.id !== id));
        setDenying(null);
        await poll();
      } catch (error) {
        if (mountedRef.current) toast.error(`提交审批失败：${errorText(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [sessionId, poll],
  );

  /**
   * 弹一条常驻通知。
   *
   * 【为什么光有页面上的审批条不够】agent 是挂起状态,它在等一个人点按钮。
   * 而这个条只在对话区下方 —— 用户滚到上面看历史、或者切去别的标签页,
   * 就完全不知道有东西在等自己,10 分钟后静默变成"自动拒绝"。
   * 窄屏例外(见下):审批卡固定在输入框上方,通知反而会盖住对话头。
   */
  useEffect(() => {
    const live = new Set(pending.map((p) => p.id));

    // 已经裁决或已超时的,把对应通知收掉,别留在屏幕上误导人
    for (const [id, p] of [...notifiedRef.current.entries()]) {
      if (!live.has(id)) {
        toast.dismiss(id);
        notifiedRef.current.delete(id);
        // 不是自己裁决的、且已过了期限:是超时自动拒绝的
        if (
          !p.questions?.length &&
          !decidedRef.current.has(id) &&
          p.expiresAt <= Date.now() + 2000
        ) {
          toast("确认超时，已自动拒绝");
        }
      }
    }

    const isNarrow = window.matchMedia(NARROW).matches;
    for (const p of pending) {
      if (notifiedRef.current.has(p.id)) continue;
      notifiedRef.current.set(p.id, p);
      if (p.questions?.length) {
        // 提问在对话里的卡片上作答,卡片在眼前就不打扰;窄屏一律不弹(会挡住对话头)。
        // 卡片要等对话流渲染出来:稍等一下再看它在不在视口里。只是提醒,几秒后自己消失
        if (isNarrow) continue;
        const ask = p;
        window.setTimeout(() => {
          if (!mountedRef.current || !notifiedRef.current.has(ask.id)) return;
          if (
            !shouldNotifyQuestion({
              narrow: window.matchMedia(NARROW).matches,
              pageVisible: document.visibilityState === "visible",
              cardInView: questionCardInView(ask.toolUseId),
            })
          ) {
            return;
          }
          toast.info("智能体在问你问题", {
            id: ask.id,
            description: `${ask.summary}（在对话里的提问卡片上回答）`,
            duration: 6000,
          });
        }, 1200);
        continue;
      }
      // 窄屏的审批卡固定在输入框上方,一直看得到;常驻通知在窄屏贴着顶栏,会挡住对话头
      // (会话列表、执行详情等开关),不再重复弹
      if (isNarrow) continue;
      toast.warning(`智能体在等你确认：${p.toolName}`, {
        id: p.id,
        description: p.summary,
        // 常驻到裁决为止 —— 自动消失等于把人重新推回"不知道有事在等"
        duration: Number.POSITIVE_INFINITY,
        action: { label: "批准", onClick: () => void decide(p.id, "approved") },
        cancel: { label: "拒绝", onClick: () => void decide(p.id, "denied") },
      });
    }
  }, [pending, decide]);

  // 组件卸载(切会话、离开页面)时把残留通知清掉
  useEffect(
    () => () => {
      for (const id of notifiedRef.current.keys()) toast.dismiss(id);
      notifiedRef.current.clear();
    },
    [],
  );

  const revoke = async (g: Grant) => {
    if (!sessionId) return;
    try {
      await fetchJson(`/api/sessions/${sessionId}/approvals?grant=${encodeURIComponent(g.key)}`, {
        method: "DELETE",
      });
      if (!mountedRef.current) return;
      toast.success(`已撤销：${g.label} 将重新逐次审批`);
      await poll();
    } catch (error) {
      if (mountedRef.current) toast.error(`撤销失败：${errorText(error)}`);
    }
  };

  const grantStrip =
    grants.length > 0 ? (
      <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground max-md:mx-3">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span>本会话已授权不再询问：</span>
        {grants.map((g) => (
          <span
            key={g.key}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-success-soft pr-1 pl-2.5 text-xs text-success-text"
          >
            {g.label}
            <button
              type="button"
              className="h-[22px] rounded-full px-2 text-xs hover:bg-[#D6E5DA] max-md:h-9"
              aria-label={`撤销授权：${g.label}`}
              onClick={() => void revoke(g)}
            >
              撤销
            </button>
          </span>
        ))}
      </div>
    ) : null;

  if (approvals.length === 0 && pollError === null) return grantStrip;

  // 窄屏:授权条收进(展开后的)审批卡里,不再单独占一行
  const grantsInCard = narrow && approvals.length > 0;

  return (
    <>
      {!grantsInCard && grantStrip}
      {pollError && (
        <div className="mx-5 mb-2.5 flex flex-wrap items-center gap-2.5 rounded-[14px] border border-[#EBC5BB] bg-[#FCF3F0] px-3.5 py-3 text-sm max-md:mx-3">
          <AlertTriangle className="size-[18px] shrink-0 text-destructive" />
          <b className="font-semibold">审批状态读取失败</b>
          <span className="text-[13px] text-muted-foreground">
            可能有待你确认的操作没显示出来（{pollError}）
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void poll()}
          >
            <RefreshCw />
            重试
          </Button>
        </div>
      )}
      <div className="mx-5 mb-2.5 max-h-[50vh] min-h-0 shrink-0 space-y-3 overflow-y-auto max-md:mx-3 max-md:max-h-[40dvh] max-md:space-y-2">
        {approvals.map((p) => {
          const leftMs = Math.max(0, p.expiresAt - now);
          const isUrgent = leftMs <= 30_000;
          const countdown = (
            <span
              className={cn(
                "inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-xs tabular-nums",
                isUrgent
                  ? "bg-destructive-soft text-destructive"
                  : "bg-warning-soft text-warning-text",
              )}
            >
              {leftMs > 0
                ? `${isUrgent ? "即将超时，" : ""}${formatLeft(leftMs)} 后自动拒绝`
                : "即将超时"}
            </span>
          );

          // 窄屏默认收成一行:标题、倒计时、批准、展开 —— 不把对话流挤没
          if (narrow && !open.has(p.id)) {
            return (
              <section
                key={p.id}
                aria-label="待你确认"
                className="flex items-center gap-2 rounded-[14px] border border-[#E7C78C] bg-[#FFF9EC] py-1 pr-1 pl-3 text-sm"
              >
                <ShieldAlert className="size-4 shrink-0 text-warning" />
                <b className="min-w-0 flex-1 truncate font-semibold">等你确认：{p.toolName}</b>
                <span
                  title={`${formatLeft(leftMs)} 后自动拒绝`}
                  className={cn(
                    "inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-xs tabular-nums",
                    isUrgent
                      ? "bg-destructive-soft text-destructive"
                      : "bg-warning-soft text-warning-text",
                  )}
                >
                  {formatLeft(leftMs)}
                </span>
                <Button
                  size="sm"
                  className="h-11"
                  onClick={() => void decide(p.id, "approved")}
                  disabled={busy === p.id}
                >
                  批准
                </Button>
                <button
                  type="button"
                  aria-label="展开审批详情"
                  aria-expanded={false}
                  onClick={() => setOpen((cur) => new Set(cur).add(p.id))}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[#F4EBD6]"
                >
                  <ChevronDown className="size-4" />
                </button>
              </section>
            );
          }

          return (
            <section
              key={p.id}
              aria-label="待你确认"
              className="rounded-[14px] border border-[#E7C78C] bg-[#FFF9EC] px-3.5 py-3"
            >
              {/* 标题行:图标 + 原因 + 倒计时 */}
              <div className="flex flex-wrap items-center gap-2.5 text-sm">
                <ShieldAlert className="size-[18px] shrink-0 text-warning" />
                <b className="min-w-0 font-semibold">智能体在等你确认 —— {p.reason}</b>
                <span className="ml-auto" />
                {countdown}
                {narrow && (
                  <button
                    type="button"
                    aria-label="收起审批详情"
                    aria-expanded
                    onClick={() =>
                      setOpen((cur) => {
                        const next = new Set(cur);
                        next.delete(p.id);
                        return next;
                      })
                    }
                    className="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[#F4EBD6]"
                  >
                    <ChevronDown className="size-4 rotate-180" />
                  </button>
                )}
              </div>

              {/* 工具调用摘要 */}
              <div className="my-2 whitespace-pre-wrap break-all rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px] leading-[1.6]">
                <b className="font-semibold">{p.toolName}</b> {p.summary}
              </div>

              {/* 操作按钮:批准一次 / 本会话内同类不再询问 / 拒绝(可附说明,会交给智能体) */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void decide(p.id, "approved")}
                  disabled={busy === p.id}
                  className="max-md:h-11"
                >
                  批准
                </Button>
                {p.scopes && p.scopes.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void decide(p.id, "approved", { remember: "session" })}
                    disabled={busy === p.id}
                    title="之后本会话里同一类调用直接放行;可在上方随时撤销"
                    className="h-auto min-h-8 py-1 whitespace-normal text-left max-md:min-h-11"
                  >
                    批准，本会话内 {p.scopes.map((s) => s.label).join("、")} 不再询问
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void decide(p.id, "denied")}
                  disabled={busy === p.id}
                  className="max-md:h-11"
                >
                  拒绝
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDenying((cur) => (cur?.id === p.id ? null : { id: p.id, text: "" }))
                  }
                  disabled={busy === p.id}
                  className="max-md:h-11"
                >
                  拒绝并说明…
                </Button>
              </div>
              {denying?.id === p.id && (
                <div className="mt-2 flex gap-2">
                  <textarea
                    // biome-ignore lint/a11y/noAutofocus: 点了"拒绝并说明"就是要马上输入
                    autoFocus
                    rows={2}
                    maxLength={2000}
                    value={denying.text}
                    onChange={(e) => setDenying({ id: p.id, text: e.target.value })}
                    placeholder="告诉智能体为什么不行、该怎么改（会作为拒绝原因交给它）"
                    aria-label="拒绝说明"
                    className="min-w-0 flex-1 resize-none rounded-[10px] border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[#9C978B] focus:ring-[3px] focus:ring-[#ECE9E1]"
                  />
                  <Button
                    size="sm"
                    disabled={busy === p.id || !denying.text.trim()}
                    onClick={() => void decide(p.id, "denied", { message: denying.text.trim() })}
                    className="self-start max-md:h-11"
                  >
                    拒绝并发送
                  </Button>
                </div>
              )}
              {grantsInCard && grants.length > 0 && (
                <div className="-mx-5 mt-2 -mb-2 max-md:-mx-3">{grantStrip}</div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
