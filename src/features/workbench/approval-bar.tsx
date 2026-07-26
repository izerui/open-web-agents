"use client";

import { useCallback, useEffect, useState } from "react";

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
    <div className="space-y-2 border-amber-500/40 border-t bg-amber-500/10 p-3">
      {pending.map((p) => {
        const secsLeft = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
        return (
          <div key={p.id} className="space-y-1">
            <p className="font-medium text-xs">
              ⏸ agent 在等你确认 —— {p.reason}
              <span className="ml-2 font-normal opacity-60">
                {secsLeft > 0 ? `${secsLeft}s 后自动拒绝` : "即将超时"}
              </span>
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
              {p.toolName}: {p.summary}
            </pre>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded bg-black px-3 py-1 text-white text-xs disabled:opacity-40 dark:bg-white dark:text-black"
                onClick={() => decide(p.id, "approved")}
                disabled={busy === p.id}
              >
                批准
              </button>
              <button
                type="button"
                className="rounded bg-red-600 px-3 py-1 text-white text-xs disabled:opacity-40"
                onClick={() => decide(p.id, "denied")}
                disabled={busy === p.id}
              >
                拒绝
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
