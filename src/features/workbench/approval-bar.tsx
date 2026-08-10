"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { CheckCircle2, Clock, ShieldAlert, Terminal, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface Pending {
  id: string;
  toolName: string;
  summary: string;
  reason: string;
  createdAt?: number;
  expiresAt: number;
}

/** 没有 createdAt 时的兜底总时长,与 container.ts 的 APPROVAL_TIMEOUT_MS 对齐。 */
const FALLBACK_WINDOW_MS = 10 * 60_000;

/** 10 分钟的窗口显示成 "600s" 没法读,超过一分钟就用 mm:ss。 */
function formatLeft(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 待审批条。运行中轮询待审列表 —— agent 已经挂起在等裁决,
 * 界面必须让人看得到、点得了,否则只会等到超时自动拒。
 */
export function ApprovalBar({
  sessionId,
  running,
}: {
  sessionId: string | null;
  running: boolean;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * 【为什么倒计时要自己的 tick】剩余时间原本是在渲染时用 Date.now() 算的,
   * 而重渲染只由 2 秒一次的轮询触发 —— 跳着走。更糟的是运行一结束就不再轮询,
   * 倒计时直接冻在最后一次的数字上,而后端仍在正常倒数到自动拒绝。
   */
  const [now, setNow] = useState(() => Date.now());
  /** 已经弹过 toast 的待审 id —— 轮询每 2 秒回来一次,不能重复弹。 */
  const notifiedRef = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const d = (await fetch(`/api/sessions/${sessionId}/approvals`).then((r) => r.json())) as {
        pending?: Pending[];
      };
      setPending(d.pending ?? []);
    } catch {
      // 轮询失败不打断界面
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setPending([]);
      return;
    }
    void poll();
    // 只在运行中轮询;跑完就没有新的待审了
    if (!running) return;
    const t = setInterval(() => void poll(), 2000);
    return () => clearInterval(t);
  }, [sessionId, running, poll]);

  // 有待审时才每秒走一次,没有就不空转
  useEffect(() => {
    if (pending.length === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  const decide = useCallback(
    async (id: string, decision: "approved" | "denied") => {
      if (!sessionId) return;
      setBusy(id);
      try {
        await fetch(`/api/sessions/${sessionId}/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: id, decision }),
        });
        await poll();
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
   */
  useEffect(() => {
    const live = new Set(pending.map((p) => p.id));

    // 已经裁决或已超时的,把对应通知收掉,别留在屏幕上误导人
    for (const id of [...notifiedRef.current]) {
      if (!live.has(id)) {
        toast.dismiss(id);
        notifiedRef.current.delete(id);
      }
    }

    for (const p of pending) {
      if (notifiedRef.current.has(p.id)) continue;
      notifiedRef.current.add(p.id);
      toast.warning(`agent 在等你确认:${p.toolName}`, {
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
      for (const id of notifiedRef.current) toast.dismiss(id);
      notifiedRef.current.clear();
    },
    [],
  );

  if (pending.length === 0) return null;

  return (
    <Card className="mx-3 mb-2 border-[var(--warning)]/40 bg-[var(--warning)]/5">
      <CardContent className="space-y-3 p-3">
        {pending.map((p, idx) => {
          const leftMs = Math.max(0, p.expiresAt - now);
          const windowMs = p.createdAt ? p.expiresAt - p.createdAt : FALLBACK_WINDOW_MS;
          const leftPct = windowMs > 0 ? (leftMs / windowMs) * 100 : 0;
          const isUrgent = leftMs <= 30_000;

          return (
            <div key={p.id}>
              {idx > 0 && <Separator className="mb-3" />}

              {/* 标题行:图标 + 待确认标签 + 原因 + 倒计时 */}
              <div className="flex items-center gap-2 text-xs">
                <ShieldAlert
                  className={cn(
                    "size-4 shrink-0",
                    isUrgent ? "text-destructive" : "text-[var(--warning)]",
                  )}
                />
                <Badge variant="warning">待确认</Badge>
                <span className="font-medium">agent 在等你确认 —— {p.reason}</span>
                <span
                  className={cn(
                    "ml-auto flex shrink-0 items-center gap-1 font-mono text-muted-foreground",
                    isUrgent && "text-destructive",
                  )}
                >
                  <Clock className="size-3" />
                  {leftMs > 0 ? `${formatLeft(leftMs)} 后自动拒绝` : "即将超时"}
                </span>
              </div>

              {/* 剩余时间条 —— 数字要读,长度一眼就看见 */}
              <Progress
                value={leftPct}
                className={cn("mt-2 h-1", isUrgent && "[&>*]:bg-destructive")}
              />

              {/* 工具调用摘要 */}
              <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-2">
                <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <code className="flex-1 whitespace-pre-wrap break-all font-mono text-xs">
                  <Badge variant="secondary" className="mr-1.5 align-middle">
                    {p.toolName}
                  </Badge>
                  {p.summary}
                </code>
              </div>

              {/* 操作按钮 */}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void decide(p.id, "approved")}
                  disabled={busy === p.id}
                  className="gap-1.5"
                >
                  <CheckCircle2 className="size-3.5" />
                  批准
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void decide(p.id, "denied")}
                  disabled={busy === p.id}
                  className="gap-1.5"
                >
                  <XCircle className="size-3.5" />
                  拒绝
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
