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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { BatchLine } from "@/lib/modules/billing/application/batch-credit";
import { MAX_BATCH_EMAILS } from "@/lib/modules/billing/domain/batch-credit";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

const STATUS: Record<BatchLine["status"], string> = {
  ready: "可发放",
  credited: "已发放",
  replayed: "此前已发放,未重复入账",
  disabled: "账号已停用,跳过",
  not_found: "没有这个账号,跳过",
  invalid: "邮箱格式不对,跳过",
  duplicate: "重复,只发一次",
  failed: "发放失败",
};

/** 管理员按邮箱批量发放积分:先预览,确认后对可发放的账号逐个入账 */
export function BatchCreditForm({ onDone }: { onDone?: () => unknown }) {
  const [emails, setEmails] = useState("");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<BatchLine[] | null>(null);
  const [applied, setApplied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 相同内容重试沿用同一批次编号:不会重复入账
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  const ready = lines?.filter((l) => l.status === "ready").length ?? 0;
  /**
   * 上一次发放还没处理完的(失败、或已到账但审计待补)。和表格分开存:之后点预览会换掉表格,
   * 但重试入口要保留 —— 重试直接重放原请求,不受预览里的停用判断限制(已到账的按原流水重放)。
   * 改了邮箱、积分或说明就是另一批,才清掉。
   */
  const [pending, setPending] = useState<{ failed: number; audit: number } | null>(null);
  const toRetry = pending ? pending.failed + pending.audit : 0;

  function changed() {
    setLines(null);
    setApplied(false);
    setPending(null);
  }

  async function preview() {
    setError("");
    try {
      if (BigInt(parseCredits(credits.trim())) <= 0n) throw new Error("发放积分必须大于零");
      if (!reason.trim()) throw new Error("请填写发放说明");
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setBusy(true);
    try {
      const r = await fetchJson<{ lines: BatchLine[] }>("/api/billing/credits/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, preview: true }),
      });
      setLines(r.lines);
      setApplied(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError("");
    const payload = JSON.stringify({ emails, credits: credits.trim(), reason: reason.trim() });
    if (attempt.current?.payload !== payload) {
      attempt.current = { payload, key: crypto.randomUUID() };
    }
    try {
      const r = await fetchJson<{
        lines: BatchLine[];
        credited: number;
        replayed: number;
        failed: number;
        auditPending: number;
      }>("/api/billing/credits/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: payload,
      });
      setLines(r.lines);
      setApplied(true);
      setConfirm(false);
      setPending(r.failed || r.auditPending ? { failed: r.failed, audit: r.auditPending } : null);
      const summary = `已向 ${r.credited} 个账号发放${r.replayed ? `,${r.replayed} 个此前已发放` : ""}${r.failed ? `,${r.failed} 个失败` : ""}${r.auditPending ? `,${r.auditPending} 个审计待补` : ""}`;
      if (r.failed || r.auditPending) toast.warning(`${summary},请用原批次重试`);
      else toast.success(summary);
      await onDone?.();
    } catch (err) {
      setError(`${errorText(err)}。相同内容重试会沿用原批次编号,不会重复入账。`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 space-y-3 border-b pb-5" aria-label="批量发放积分">
      <h2 className="text-sm font-semibold">按邮箱批量发放</h2>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <label className="space-y-1 text-sm sm:row-span-2" htmlFor="batch-emails">
          <span>邮箱(每行一个,也可用逗号分隔;最多 {MAX_BATCH_EMAILS} 个)</span>
          <Textarea
            id="batch-emails"
            className="min-h-28 font-mono text-xs"
            value={emails}
            onChange={(e) => {
              setEmails(e.target.value);
              changed();
            }}
          />
        </label>
        <label className="space-y-1 text-sm" htmlFor="batch-credits">
          <span>每人积分</span>
          <Input
            id="batch-credits"
            inputMode="decimal"
            value={credits}
            onChange={(e) => {
              setCredits(e.target.value);
              changed();
            }}
          />
        </label>
        <label className="space-y-1 text-sm" htmlFor="batch-reason">
          <span>发放说明</span>
          <Input
            id="batch-reason"
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              changed();
            }}
          />
        </label>
      </fieldset>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || !emails.trim()} onClick={() => void preview()}>
          预览
        </Button>
        {toRetry > 0 && pending && (
          <Button disabled={busy} onClick={() => void apply()}>
            用原批次重试(
            {[
              pending.failed ? `${pending.failed} 个失败` : "",
              pending.audit ? `${pending.audit} 个审计待补` : "",
            ]
              .filter(Boolean)
              .join(",")}
            )
          </Button>
        )}
        {lines && !applied && (
          <Button disabled={busy || ready === 0} onClick={() => setConfirm(true)}>
            <Send className="size-4" />向 {ready} 个账号发放
          </Button>
        )}
      </div>
      {error && !confirm && (
        <p aria-live="assertive" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {lines && (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-left text-xs" data-testid="batch-lines">
            <caption className="sr-only">批量发放结果</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="px-2 py-2">
                  邮箱
                </th>
                <th scope="col" className="px-2 py-2">
                  {applied ? "结果" : "预览"}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.email}-${i}`} className="border-b">
                  <td className="break-all px-2 py-2 font-mono">{l.email}</td>
                  <td
                    className={
                      l.status === "ready" || l.status === "credited"
                        ? "px-2 py-2"
                        : "px-2 py-2 text-muted-foreground"
                    }
                  >
                    {"auditPending" in l && l.auditPending
                      ? "已到账,审计待补(用原批次重试)"
                      : STATUS[l.status]}
                    {l.status === "failed" ? `:${l.error}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认批量发放</DialogTitle>
            <DialogDescription>
              向 {ready} 个账号各发放 {credits.trim()}{" "}
              积分。这次操作直接发放平台积分,不代表支付渠道已经收款。
            </DialogDescription>
          </DialogHeader>
          <p className="break-words text-sm">说明:{reason.trim()}</p>
          {error && (
            <p aria-live="assertive" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void apply()}>
              {busy ? "处理中…" : "确认发放"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
