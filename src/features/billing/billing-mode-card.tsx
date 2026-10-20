"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import type { BillingMode } from "@/lib/modules/billing/domain/run-charge";
import type { TrialStats } from "@/lib/modules/billing/run-charge-ports";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const MODE_TEXT: Record<BillingMode, string> = { trial: "试算", live: "正式扣费" };

/** 管理员:计费模式与本月试算统计。切换只影响之后受理的运行。 */
export function BillingModeCard({ onChanged }: { onChanged?: () => unknown }) {
  const [state, setState] = useState<{ mode: BillingMode; trial: TrialStats } | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<BillingMode | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await fetchJson("/api/admin/billing-mode"));
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function apply(mode: BillingMode) {
    setBusy(true);
    try {
      await fetchJson("/api/admin/billing-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      toast.success(`计费模式已切换为「${MODE_TEXT[mode]}」`);
      setConfirm(null);
      await load();
      await onChanged?.();
    } catch (err) {
      toast.error(`切换失败:${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="mb-5 text-sm text-destructive">计费模式载入失败:{error}</p>;
  if (!state) return null;
  const next: BillingMode = state.mode === "trial" ? "live" : "trial";
  return (
    <section className="mb-6 space-y-3 border-b pb-5" aria-label="计费模式">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">计费模式</h2>
        <span
          data-testid="billing-mode"
          className="rounded bg-muted px-2 py-0.5 text-xs font-medium"
        >
          {MODE_TEXT[state.mode]}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => setConfirm(next)}
        >
          切换为{MODE_TEXT[next]}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {state.mode === "trial"
          ? "试算中:运行照常进行,按真实售价记录预计消耗,不扣任何积分;余额或上限不够时只记录「本应拒绝」,不拦截。"
          : "正式扣费:每次运行受理时冻结积分,结束后按实际用量扣除、多余退回;余额或上限不够的拒绝发起。"}
      </p>
      <dl className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">本月试算运行</dt>
          <dd className="mt-1 font-mono">{state.trial.runs}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">本月试算预计消耗</dt>
          <dd className="mt-1 font-mono">{creditsAmount(state.trial.estimatedMicro)} 积分</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">本应拒绝</dt>
          <dd className="mt-1 font-mono">{state.trial.wouldReject} 次</dd>
        </div>
      </dl>
      <Dialog open={confirm !== null} onOpenChange={(open) => !busy && !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>切换为{confirm ? MODE_TEXT[confirm] : ""}?</DialogTitle>
            <DialogDescription>
              {confirm === "live"
                ? "之后受理的运行将按实际用量扣积分,余额或月度上限不够的账号与 API Key 将无法发起运行。"
                : "之后受理的运行只记录预计消耗,不再扣积分。"}
              已受理(排队中、运行中)的运行仍按受理时的模式结算。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => confirm && void apply(confirm)}>
              {busy ? "处理中…" : "确认切换"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
