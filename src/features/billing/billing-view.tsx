"use client";

import { SpaceShell } from "@/components/space-shell";
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
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { SummaryWindow } from "@/lib/modules/billing/domain/charge-summary";
import {
  creditsAmount,
  creditsBalance,
  creditsExact,
} from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry, WalletBalance } from "@/lib/modules/billing/ports";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { ArrowDownToLine, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BatchCreditForm } from "./batch-credit-form";
import { type ChargeDrill, ChargeSummary, WINDOW_LABEL } from "./charge-summary";
import { PendingCharges } from "./pending-charges";
import { ReconciliationView } from "./reconciliation-view";
import { RunChargeList } from "./run-charge-list";

type Statement = {
  balance: WalletBalance;
  items: LedgerEntry[];
  nextCursor?: string;
  month?: {
    since: number;
    usedMicroCredits: string;
    limitMicroCredits: string | null;
    limitPending?: boolean;
  };
};
type Account = { id: string; email: string; disabled?: boolean };
const KIND = { credit: "人工入账", reserve: "冻结", settle: "结算", refund: "多扣退还" } as const;

export function BillingView({ admin = false }: { admin?: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState("");
  const requestSeq = useRef(0);
  const pending = useRef(false);
  const creditAttempt = useRef<{ payload: string; key: string } | null>(null);
  /** 从消耗汇总点进来的运行明细筛选;换账号时清掉 */
  const [drill, setDrill] = useState<ChargeDrill | null>(null);
  /** 账号汇总的初始时间范围:从全平台汇总点账号进来时沿用那边的,其余默认本月 */
  const [accountRange, setAccountRange] = useState<SummaryWindow>("this_month");

  const loadAccounts = useCallback(async () => {
    try {
      const result = await fetchJson<{ accounts: Account[] }>("/api/admin/accounts");
      setAccounts(result.accounts);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    if (admin) void loadAccounts();
  }, [admin, loadAccounts]);

  const load = useCallback(
    async (cursor?: string) => {
      if (admin && !accountId) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ limit: "50" });
      if (admin) params.set("accountId", accountId);
      if (cursor) params.set("cursor", cursor);
      try {
        const result = await fetchJson<Statement>(`/api/billing?${params}`);
        if (seq !== requestSeq.current) return;
        setStatement((previous) => ({
          ...result,
          month: result.month ?? previous?.month,
          items:
            cursor && previous?.balance.accountId === result.balance.accountId
              ? [...previous.items, ...result.items]
              : result.items,
        }));
      } catch (err) {
        if (seq === requestSeq.current) setError(errorText(err));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [admin, accountId],
  );
  useEffect(() => {
    setStatement(null);
    void load();
    return () => {
      requestSeq.current++;
    };
  }, [load]);

  function reviewCredit() {
    setError("");
    try {
      if (!accountId) throw new Error("请选择账号");
      if (BigInt(parseCredits(credits.trim())) <= 0n) throw new Error("发放积分必须大于零");
      if (!reason.trim()) throw new Error("请填写入账说明");
      setConfirm(true);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function credit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const payload = JSON.stringify({ accountId, credits: credits.trim(), reason: reason.trim() });
    if (creditAttempt.current?.payload !== payload) {
      creditAttempt.current = { payload, key: crypto.randomUUID() };
    }
    try {
      const result = await fetchJson<{
        balance: WalletBalance;
        entry: LedgerEntry;
        replayed: boolean;
      }>("/api/billing/credits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": creditAttempt.current.key,
        },
        body: payload,
      });
      setReceipt(
        `${result.replayed ? "已确认原入账" : "入账成功"}: ${formatCredits(result.entry.amountMicroCredits)} 积分 · 流水 ${result.entry.id}`,
      );
      setCredits("");
      setReason("");
      setConfirm(false);
      creditAttempt.current = null;
      toast.success(result.replayed ? "原请求已处理,未重复入账" : "积分已入账");
      setStatement((previous) => ({
        ...previous,
        balance: result.balance,
        items: previous?.items ?? [],
      }));
      await load();
    } catch (err) {
      setError(`${errorText(err)}。相同内容重试会沿用原请求编号。`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const selected = accounts.find((account) => account.id === accountId);
  return (
    <SpaceShell area={admin ? "admin" : "personal"} title={admin ? "积分管理" : "积分账户"}>
      {admin && <ReconciliationView />}
      {admin && (
        <ChargeSummary
          platform
          onSelectAccount={(id, range) => {
            requestSeq.current++;
            setStatement(null);
            setAccountId(id);
            setAccountRange(range);
            // 明细也只看这段时间,和刚才那笔汇总对得上
            setDrill({
              label: `${WINDOW_LABEL[range]} · 该账号全部运行`,
              params: { window: range },
            });
            setReceipt("");
            creditAttempt.current = null;
          }}
        />
      )}
      {admin && <BatchCreditForm onDone={() => load()} />}
      {admin && (
        <PendingCharges
          onSelectAccount={(id) => {
            requestSeq.current++;
            setStatement(null);
            setAccountId(id);
            setAccountRange("this_month");
            setDrill(null);
            setReceipt("");
            creditAttempt.current = null;
          }}
        />
      )}
      {statement && (
        <div className="mb-5 border-b pb-4 text-sm text-muted-foreground">
          每次运行发起时先冻结积分,结束后按实际用量扣除,多余的退回可用余额。
        </div>
      )}
      {admin && (
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 space-y-1 text-sm" htmlFor="billing-account">
            <span>账号</span>
            <NativeSelect
              id="billing-account"
              value={accountId}
              disabled={busy}
              onChange={(event) => {
                requestSeq.current++;
                setStatement(null);
                setAccountId(event.target.value);
                setAccountRange("this_month");
                setDrill(null);
                setReceipt("");
                creditAttempt.current = null;
              }}
            >
              <option value="">选择账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                  {account.disabled ? "（已停用）" : ""}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button
            variant="ghost"
            size="icon"
            title="刷新账号列表"
            onClick={() => void loadAccounts()}
            disabled={busy}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      )}
      {error && !confirm && (
        <p aria-live="assertive" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {receipt && (
        <output className="mb-4 block break-words text-sm text-emerald-600">{receipt}</output>
      )}
      {statement ? (
        <dl className="mb-6 grid grid-cols-2 gap-6 border-y py-5">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">可用</dt>
            <dd
              data-testid="balance-available"
              className="mt-2 break-all font-mono text-2xl"
              title={`${creditsExact(statement.balance.availableMicroCredits)} 积分`}
            >
              {creditsBalance(statement.balance.availableMicroCredits)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">冻结中</dt>
            <dd
              data-testid="balance-reserved"
              className="mt-2 break-all font-mono text-2xl"
              title={`${creditsExact(statement.balance.reservedMicroCredits)} 积分`}
            >
              {creditsAmount(statement.balance.reservedMicroCredits)}
            </dd>
          </div>
          {statement.month && (
            <p className="col-span-2 text-xs text-muted-foreground">
              本月已用 {creditsAmount(statement.month.usedMicroCredits)} 积分
              {statement.month.limitMicroCredits !== null &&
                ` / 月度上限 ${creditsAmount(statement.month.limitMicroCredits)} 积分`}
              {statement.month.limitPending &&
                " · 原月度上限待管理员按积分重新设置,设置前不能发起运行"}
            </p>
          )}
        </dl>
      ) : loading ? (
        <p className="py-5 text-sm text-muted-foreground">载入中…</p>
      ) : admin && !accountId ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          <Wallet className="mx-auto mb-3 size-8" />
          选择账号查看余额与流水
        </div>
      ) : null}

      {admin && accountId && (
        <form
          className="mb-6 space-y-3 border-b pb-5"
          onSubmit={(event) => {
            event.preventDefault();
            reviewCredit();
          }}
        >
          <h2 className="text-sm font-semibold">人工发放积分</h2>
          <fieldset
            disabled={busy}
            className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
          >
            <label className="space-y-1 text-sm" htmlFor="credit-amount">
              <span>积分数量</span>
              <Input
                id="credit-amount"
                required
                inputMode="decimal"
                value={credits}
                onChange={(event) => setCredits(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm" htmlFor="credit-reason">
              <span>入账说明</span>
              <Textarea
                id="credit-reason"
                required
                maxLength={500}
                className="min-h-9 resize-y"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy}>
              <ArrowDownToLine className="size-4" />
              发放积分
            </Button>
          </fieldset>
        </form>
      )}
      {statement && (
        <ChargeSummary
          key={admin ? `${accountId}:${accountRange}` : "self"}
          accountId={admin ? accountId : undefined}
          initialRange={accountRange}
          onDrill={setDrill}
        />
      )}
      {statement && (
        <RunChargeList
          accountId={admin ? accountId : undefined}
          drill={drill}
          onClearDrill={() => setDrill(null)}
        />
      )}
      {statement && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">账户流水</h2>
            <Button
              variant="ghost"
              size="icon"
              title="刷新流水"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {statement.items.length === 0 ? (
            <p className="py-5 text-sm text-muted-foreground">暂无流水</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">积分账户流水</caption>
                <thead>
                  <tr className="border-b text-muted-foreground">
                    {["时间", "类型", "积分", "可用余额", "说明 / 关联"].map((title) => (
                      <th scope="col" key={title} className="px-2 py-3">
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {statement.items.map((entry) => (
                    <tr key={entry.id} className="border-b align-top">
                      <td className="whitespace-nowrap px-2 py-3">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3">
                        {entry.kind === "settle" && entry.amountMicroCredits === "0"
                          ? "释放冻结"
                          : KIND[entry.kind]}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-mono">
                        {entry.kind === "credit" || entry.kind === "refund"
                          ? "+"
                          : entry.kind === "settle" && entry.amountMicroCredits !== "0"
                            ? "-"
                            : ""}
                        {creditsExact(entry.amountMicroCredits)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-mono">
                        {creditsExact(entry.availableAfter)}
                        <p className="mt-1 text-muted-foreground">
                          冻结 {creditsExact(entry.reservedAfter)}
                        </p>
                      </td>
                      <td className="min-w-40 max-w-sm break-words px-2 py-3">
                        {entry.reason || entry.reference}
                        <p className="mt-1 break-all text-muted-foreground">{entry.id}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {statement.nextCursor && (
            <Button
              variant="outline"
              className="mt-4"
              disabled={loading}
              onClick={() => void load(statement.nextCursor)}
            >
              加载更早流水
            </Button>
          )}
        </section>
      )}
      <Dialog
        open={confirm}
        onOpenChange={(open) => {
          if (!busy) setConfirm(open);
        }}
      >
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>确认人工入账</DialogTitle>
            <DialogDescription>
              这次操作直接发放平台积分，不代表支付渠道已经收款。
            </DialogDescription>
          </DialogHeader>
          <dl className="min-h-0 space-y-3 overflow-y-auto text-sm">
            <div>
              <dt className="text-muted-foreground">账号</dt>
              <dd className="break-all">{selected?.email ?? accountId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">积分</dt>
              <dd className="font-mono text-lg">{credits}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">说明</dt>
              <dd className="break-words">{reason}</dd>
            </div>
          </dl>
          {error && (
            <p aria-live="assertive" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void credit()}>
              {busy ? "处理中…" : "确认发放"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SpaceShell>
  );
}
