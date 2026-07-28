"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ShieldAlert, CheckCircle2, XCircle, Clock, Terminal } from "lucide-react";

interface Pending {
  id: string;
  toolName: string;
  summary: string;
  reason: string;
  expiresAt: number;
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

  async function decide(id: string, decision: "approved" | "denied") {
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
  }

  if (pending.length === 0) return null;

  return (
    <Card className="mx-3 mb-2 border-[var(--warning)]/40 bg-[var(--warning)]/5">
      <CardContent className="space-y-3 p-3">
        {pending.map((p, idx) => {
          const secsLeft = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
          const isUrgent = secsLeft <= 10;

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
                  {secsLeft > 0 ? `${secsLeft}s 后自动拒绝` : "即将超时"}
                </span>
              </div>

              {/* 工具调用摘要 */}
              <div className="mt-1.5 flex items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-2">
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
                  onClick={() => decide(p.id, "approved")}
                  disabled={busy === p.id}
                  className="gap-1.5"
                >
                  <CheckCircle2 className="size-3.5" />
                  批准
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => decide(p.id, "denied")}
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
