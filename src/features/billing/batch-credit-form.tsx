"use client";

import { Badge } from "@/components/ui/badge";
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
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Info, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { batchSummary, countEmails } from "./billing-display";

/** 每一行的状态标签:文字 + 颜色 */
const STATUS: Record<
  BatchLine["status"],
  { label: string; tone: "success" | "warning" | "destructive" | "outline" }
> = {
  ready: { label: "可发放", tone: "success" },
  credited: { label: "已发放", tone: "success" },
  replayed: { label: "此前已发放，未重复入账", tone: "outline" },
  disabled: { label: "跳过：账号已停用", tone: "warning" },
  not_found: { label: "跳过：没有这个账号", tone: "warning" },
  invalid: { label: "跳过：邮箱格式不对", tone: "warning" },
  duplicate: { label: "跳过：重复，只发一次", tone: "warning" },
  failed: { label: "发放失败", tone: "destructive" },
};

const STEPS = ["填写", "预览", "结果"] as const;

function Steps({ step }: { step: number }) {
  return (
    <ol className="mb-1 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      {STEPS.map((t, i) => (
        <li
          key={t}
          className={cn("flex items-center gap-1.5", step === i && "font-semibold text-foreground")}
          aria-current={step === i ? "step" : undefined}
        >
          {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
          <span
            className={cn(
              "inline-grid size-[22px] place-items-center rounded-full bg-[#ECEAE3] text-xs text-[#4D4A43]",
              step === i && "bg-primary text-primary-foreground",
              step > i && "bg-success text-white",
            )}
          >
            {step > i ? <Check className="size-3" /> : i + 1}
          </span>
          {t}
        </li>
      ))}
    </ol>
  );
}

function LineTable({ lines, result }: { lines: BatchLine[]; result: boolean }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm" data-testid="batch-lines">
        <caption className="sr-only">{result ? "批量发放结果" : "批量发放预览"}</caption>
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-normal">
              邮箱
            </th>
            <th scope="col" className="px-3 py-2 font-normal">
              {result ? "结果" : "预览"}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const st = STATUS[l.status];
            const auditPending = "auditPending" in l && l.auditPending;
            return (
              <tr key={`${l.email}-${i}`} className="border-b last:border-0">
                <td className="break-all px-3 py-2 font-mono text-xs">{l.email}</td>
                <td className="px-3 py-2">
                  <Badge variant={auditPending ? "warning" : st.tone}>
                    {auditPending ? "已到账，审计待补" : st.label}
                  </Badge>
                  {l.status === "failed" && (
                    <span className="ml-1.5 text-xs text-muted-foreground">{l.error}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 管理员按邮箱批量发放积分:三步弹窗(填写 → 预览 → 结果),原型 admin-billing 的批量发放。
 * 预览那一步就是确认:看清可发放和跳过的人、合计积分,再点「确认发放」。
 * 相同内容重试沿用同一批次编号,不会重复入账。
 */
export function BatchCreditDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => unknown;
}) {
  const [step, setStep] = useState(0);
  const [emails, setEmails] = useState("");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<BatchLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errField, setErrField] = useState<"emails" | "credits" | "reason" | null>(null);
  // 相同内容重试沿用同一批次编号:不会重复入账
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  /** 上一次发放没处理完的(失败、或已到账但审计待补):重试直接重放原请求 */
  const [pending, setPending] = useState<{ failed: number; audit: number } | null>(null);
  const [counts, setCounts] = useState<{ ok: number; failed: number } | null>(null);

  const emailCount = countEmails(emails);
  const sum = lines ? batchSummary(lines, credits) : null;

  function edited() {
    setLines(null);
    setPending(null);
    setError("");
    setErrField(null);
  }

  function fail(field: "emails" | "credits" | "reason", text: string) {
    setErrField(field);
    setError(text);
  }

  async function preview() {
    setError("");
    setErrField(null);
    if (emailCount === 0) return fail("emails", "请至少填一个邮箱");
    if (emailCount > MAX_BATCH_EMAILS)
      return fail("emails", `一次最多 ${MAX_BATCH_EMAILS} 个，现在有 ${emailCount} 个`);
    try {
      if (BigInt(parseCredits(credits.trim())) <= 0n) throw new Error();
    } catch {
      return fail("credits", "每人积分要填大于零的数（最多六位小数）");
    }
    if (!reason.trim()) return fail("reason", "请填写说明，会记入每个人的流水");
    setBusy(true);
    try {
      const r = await fetchJson<{ lines: BatchLine[] }>("/api/billing/credits/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, preview: true }),
      });
      setLines(r.lines);
      setStep(1);
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
      setStep(2);
      setCounts({ ok: r.credited + r.replayed, failed: r.failed });
      setPending(r.failed || r.auditPending ? { failed: r.failed, audit: r.auditPending } : null);
      const summary = `已向 ${r.credited} 个账号发放${r.replayed ? `，${r.replayed} 个此前已发放` : ""}${r.failed ? `，${r.failed} 个失败` : ""}${r.auditPending ? `，${r.auditPending} 个审计待补` : ""}`;
      if (r.failed || r.auditPending) toast.warning(`${summary}，请用原批次重试`);
      else toast.success(summary);
      await onDone?.();
    } catch (err) {
      setError(`${errorText(err)}。相同内容重试会沿用原批次编号，不会重复入账。`);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    onOpenChange(false);
    // 发完了才清空;没发完(填写、预览、待重试)关掉再打开还在原处
    if (step === 2 && !pending) {
      setStep(0);
      setEmails("");
      setCredits("");
      setReason("");
      setLines(null);
      setCounts(null);
      attempt.current = null;
    }
  }

  const fieldError = (f: "emails" | "credits" | "reason") =>
    errField === f && error ? <span className="text-xs text-destructive">{error}</span> : null;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>
            {step === 0
              ? "批量发放积分"
              : step === 1
                ? "确认发放"
                : pending
                  ? "部分没有处理完"
                  : "发放完成"}
          </DialogTitle>
          <DialogDescription>
            {step === 0
              ? `一次最多 ${MAX_BATCH_EMAILS} 个邮箱。先预览，确认后才会发放。`
              : "发放记入每个账号的流水「人工入账」，不代表支付渠道已收款。"}
          </DialogDescription>
        </DialogHeader>
        <Steps step={step} />
        <div className="min-h-0 overflow-y-auto">
          {step === 0 && (
            <form
              id="batch-credit-form"
              noValidate
              className="grid gap-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                void preview();
              }}
            >
              <fieldset disabled={busy} className="grid gap-3.5">
                <label
                  className="grid gap-1.5 text-[13px] text-muted-foreground"
                  htmlFor="batch-emails"
                >
                  <span>
                    邮箱（每行一个，或用逗号分隔） <span className="text-destructive">*</span>
                  </span>
                  <Textarea
                    id="batch-emails"
                    rows={6}
                    className="font-mono text-xs"
                    placeholder="linzhou@example.com"
                    aria-invalid={errField === "emails" || undefined}
                    value={emails}
                    onChange={(e) => {
                      setEmails(e.target.value);
                      edited();
                    }}
                  />
                  <span
                    className={cn(
                      "text-xs",
                      emailCount > MAX_BATCH_EMAILS ? "text-destructive" : "text-muted-foreground",
                    )}
                    data-testid="batch-email-count"
                  >
                    已识别 {emailCount} 个邮箱，上限 {MAX_BATCH_EMAILS}
                  </span>
                  {fieldError("emails")}
                </label>
                <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                  <label
                    className="grid content-start gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="batch-credits"
                  >
                    <span>
                      每人积分 <span className="text-destructive">*</span>
                    </span>
                    <Input
                      id="batch-credits"
                      inputMode="decimal"
                      aria-invalid={errField === "credits" || undefined}
                      value={credits}
                      onChange={(e) => {
                        setCredits(e.target.value);
                        edited();
                      }}
                    />
                    {fieldError("credits")}
                  </label>
                  <label
                    className="grid content-start gap-1.5 text-[13px] text-muted-foreground"
                    htmlFor="batch-reason"
                  >
                    <span>
                      发放说明 <span className="text-destructive">*</span>
                    </span>
                    <Input
                      id="batch-reason"
                      maxLength={500}
                      placeholder="例如 11 月部门预算"
                      aria-invalid={errField === "reason" || undefined}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        edited();
                      }}
                    />
                    {fieldError("reason")}
                  </label>
                </div>
              </fieldset>
            </form>
          )}
          {step === 1 && lines && sum && (
            <div className="grid gap-3">
              <p
                className={cn(
                  "flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm",
                  sum.ready ? "bg-band" : "border border-[#EBCB91] bg-[#FFFBF2] text-warning-text",
                )}
                data-testid="batch-summary"
              >
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>
                  向 {sum.ready} 个账号各发放 {credits.trim()} 积分，共{" "}
                  <b>{sum.totalMicro ? creditsAmount(sum.totalMicro) : "—"}</b> 积分；
                  {sum.skipped} 个跳过。说明：{reason.trim()}
                </span>
              </p>
              <LineTable lines={lines} result={false} />
            </div>
          )}
          {step === 2 && lines && (
            <div className="grid gap-3">
              {counts && (
                <dl className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-border px-4 py-3">
                    <dt className="text-xs text-muted-foreground">成功</dt>
                    <dd className="font-display text-2xl font-semibold text-success-text">
                      {counts.ok}
                    </dd>
                  </div>
                  <div className="rounded-xl border border-border px-4 py-3">
                    <dt className="text-xs text-muted-foreground">失败</dt>
                    <dd
                      className={cn(
                        "font-display text-2xl font-semibold",
                        counts.failed > 0 && "text-destructive",
                      )}
                    >
                      {counts.failed}
                    </dd>
                  </div>
                </dl>
              )}
              <LineTable lines={lines} result />
              {pending && (
                <p className="text-xs text-muted-foreground">
                  「用原批次重试」只会补处理没完成的账号，同一批次号保证不会重复入账。
                </p>
              )}
            </div>
          )}
          {error && !errField && (
            <p aria-live="assertive" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0">
          {step === 0 && (
            <>
              <Button variant="outline" disabled={busy} onClick={close}>
                取消
              </Button>
              <Button type="submit" form="batch-credit-form" disabled={busy}>
                {busy ? "正在预览…" : "预览"}
              </Button>
            </>
          )}
          {step === 1 && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep(0)}>
                返回修改
              </Button>
              <Button disabled={busy || !sum?.ready} onClick={() => void apply()}>
                {busy ? "正在发放…" : `确认发放 ${sum?.ready ?? 0} 人`}
              </Button>
            </>
          )}
          {step === 2 &&
            (pending ? (
              <>
                <Button variant="outline" disabled={busy} onClick={close}>
                  稍后处理
                </Button>
                <Button disabled={busy} onClick={() => void apply()}>
                  <RefreshCw className="size-4" />
                  用原批次重试（
                  {[
                    pending.failed ? `${pending.failed} 个失败` : "",
                    pending.audit ? `${pending.audit} 个审计待补` : "",
                  ]
                    .filter(Boolean)
                    .join("，")}
                  ）
                </Button>
              </>
            ) : (
              <Button onClick={close}>完成</Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
