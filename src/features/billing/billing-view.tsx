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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { filterParam } from "@/features/admin/account-links";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { SummaryWindow } from "@/lib/modules/billing/domain/charge-summary";
import {
  creditsAmount,
  creditsBalance,
  creditsExact,
} from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry, WalletBalance } from "@/lib/modules/billing/ports";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowDownToLine, RefreshCw, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BatchCreditDialog } from "./batch-credit-form";
import { type ChargeDrill, ChargeSummary, WINDOW_LABEL } from "./charge-summary";
import { LedgerTable } from "./ledger-table";
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
type AccountView = "overview" | "runs" | "ledger";
export type AdminView = "overview" | "accounts" | "reconciliation";

export function BillingView({
  admin = false,
  initialAdminView = "overview",
}: {
  admin?: boolean;
  /** 平台管理 /admin/billing?tab= 指定的初始分区(仅 admin) */
  initialAdminView?: AdminView;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [adminView, setAdminView] = useState<AdminView>(initialAdminView);
  const [visitedAdmin, setVisitedAdmin] = useState<AdminView[]>([initialAdminView]);
  const [accountView, setAccountView] = useState<AccountView>("overview");
  const [visitedAccount, setVisitedAccount] = useState<AccountView[]>(["overview"]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // 选中的账号记在地址 ?account= 里:刷新、分享都还在这个账号
  const [accountId, setAccountId] = useState(() =>
    admin ? filterParam(searchParams, "account") : "",
  );
  /** 发放表单没过校验的那一栏 */
  const [creditErr, setCreditErr] = useState<{ field: "credits" | "reason"; text: string } | null>(
    null,
  );
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

  /** 把分区与账号写进地址(不新增历史记录) */
  const syncUrl = useCallback(
    (view: AdminView, account: string) => {
      if (!admin) return;
      const q = new URLSearchParams(searchParams.toString());
      if (view === "overview") q.delete("tab");
      else q.set("tab", view);
      if (account) q.set("account", account);
      else q.delete("account");
      router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
    },
    [admin, pathname, router, searchParams],
  );

  function openAdminView(view: AdminView, account = accountId) {
    setAdminView(view);
    syncUrl(view, account);
    setVisitedAdmin((previous) => (previous.includes(view) ? previous : [...previous, view]));
  }

  function openAccountView(view: AccountView) {
    setAccountView(view);
    setVisitedAccount((previous) => (previous.includes(view) ? previous : [...previous, view]));
  }

  const loadAccounts = useCallback(async () => {
    try {
      const result = await fetchJson<{ accounts: Account[] }>("/api/admin/accounts");
      setAccounts(result.accounts);
      // 没指定账号时默认选第一个启用中的账号,打开「账户」就有内容
      setAccountId(
        (current) =>
          current || (result.accounts.find((a) => !a.disabled) ?? result.accounts[0])?.id || "",
      );
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
    setCreditErr(null);
    if (!accountId) return setError("请选择账号");
    try {
      if (BigInt(parseCredits(credits.trim())) <= 0n) throw new Error();
    } catch {
      return setCreditErr({ field: "credits", text: "填大于零的积分数" });
    }
    if (!reason.trim()) return setCreditErr({ field: "reason", text: "请填写说明，会记入流水" });
    setConfirm(true);
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

  /**
   * 切到某个账号查看,带上账号汇总的时间范围与运行明细的筛选。
   * 只有换了账号才清空并重新加载余额流水 —— 加载只跟着 accountId 走,
   * 同一个账号再点一次(比如在全平台汇总换了时间范围再点它)若也清空,就没有加载来承接,整块消失
   */
  function selectAccount(
    id: string,
    range: SummaryWindow = "this_month",
    next: ChargeDrill | null = null,
  ) {
    if (id !== accountId) {
      requestSeq.current++;
      setStatement(null);
      setAccountId(id);
      setVisitedAccount([]);
      setCreditErr(null);
    }
    setAccountRange(range);
    setDrill(next);
    openAdminView("accounts", id);
    openAccountView(next ? "runs" : "overview");
    setReceipt("");
    creditAttempt.current = null;
  }

  const selected = accounts.find((account) => account.id === accountId);
  return (
    <SpaceShell area={admin ? "admin" : "personal"} title={admin ? "计费" : "用量与费用"}>
      {admin && (
        <nav
          aria-label="计费管理分区"
          className="mb-5 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border"
        >
          {(
            [
              ["overview", "概览"],
              ["accounts", "账户"],
              ["reconciliation", "对账"],
            ] as const
          ).map(([view, label]) => (
            <button
              key={view}
              type="button"
              aria-current={adminView === view ? "page" : undefined}
              aria-controls={`billing-${view}`}
              onClick={() => openAdminView(view)}
              className={cn(
                "-mb-px flex h-11 shrink-0 items-center border-b-2 border-transparent px-3.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent",
                adminView === view && "border-foreground font-semibold text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {error && !confirm && (
        <p aria-live="assertive" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {receipt && (
        <output className="mb-4 block break-words text-sm text-success">{receipt}</output>
      )}
      {admin && (
        <div id="billing-overview" hidden={adminView !== "overview"}>
          <ChargeSummary
            platform
            defaultBy="account"
            onShowPending={() => openAdminView("reconciliation")}
            onSelectAccount={(id, range) =>
              // 明细也只看这段时间,和刚才那笔汇总对得上
              selectAccount(id, range, {
                label: `${WINDOW_LABEL[range]} · 该账号全部运行`,
                params: { window: range },
              })
            }
          />
        </div>
      )}
      {admin && (
        <div id="billing-reconciliation" hidden={adminView !== "reconciliation"}>
          {visitedAdmin.includes("reconciliation") && (
            <>
              <ReconciliationView />
              <PendingCharges onSelectAccount={(id) => selectAccount(id)} />
            </>
          )}
        </div>
      )}
      <div id="billing-accounts" hidden={admin && adminView !== "accounts"}>
        {admin && (
          <div className="mb-4 flex flex-wrap items-center gap-2.5">
            <label className="text-[13px] text-muted-foreground" htmlFor="billing-account">
              账号
            </label>
            <NativeSelect
              id="billing-account"
              className="w-[320px] max-w-full"
              value={accountId}
              disabled={busy}
              onChange={(event) => selectAccount(event.target.value)}
            >
              <option value="">选择账号</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                  {account.disabled ? "（已停用）" : ""}
                </option>
              ))}
            </NativeSelect>
            <Button variant="outline" size="sm" onClick={() => void loadAccounts()} disabled={busy}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
            <Button size="sm" className="ml-auto" onClick={() => setBatchOpen(true)}>
              <Users className="size-4" />
              批量发放积分
            </Button>
          </div>
        )}
        {admin && (
          <BatchCreditDialog open={batchOpen} onOpenChange={setBatchOpen} onDone={() => load()} />
        )}
        {admin && selected?.disabled && (
          <p className="mb-4 flex items-start gap-2 rounded-xl border border-[#EBCB91] bg-[#FFFBF2] px-3.5 py-2.5 text-sm text-warning-text">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            这个账号已停用。发放的积分会留在账户里，恢复账号后才能使用。
          </p>
        )}
        {admin && accountId && (
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <section
              aria-label="账号信息"
              className="min-w-0 rounded-2xl border border-border bg-card px-[22px] py-5"
            >
              <h2 className="break-all text-base font-semibold">{selected?.email ?? accountId}</h2>
              <p className="mt-1 mb-3 text-xs text-muted-foreground">
                {selected?.disabled ? "已停用" : "启用中"}，
                <Link className="underline underline-offset-2" href="/admin/accounts">
                  在账号页修改上限或状态
                </Link>
              </p>
              <dl className="grid grid-cols-2 gap-4">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">可用</dt>
                  <dd
                    data-testid="balance-available"
                    className="mt-1 break-all font-display text-2xl font-semibold"
                    title={
                      statement
                        ? `${creditsExact(statement.balance.availableMicroCredits)} 积分`
                        : undefined
                    }
                  >
                    {statement ? creditsBalance(statement.balance.availableMicroCredits) : "—"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">冻结中</dt>
                  <dd
                    data-testid="balance-reserved"
                    className="mt-1 break-all font-display text-2xl font-semibold"
                    title={
                      statement
                        ? `${creditsExact(statement.balance.reservedMicroCredits)} 积分`
                        : undefined
                    }
                  >
                    {statement ? creditsAmount(statement.balance.reservedMicroCredits) : "—"}
                  </dd>
                </div>
              </dl>
            </section>
            <section
              aria-label="人工发放积分"
              className="min-w-0 rounded-2xl border border-border bg-card px-[22px] py-5"
            >
              <h2 className="text-base font-semibold">人工发放积分</h2>
              <p className="mt-1 mb-3 text-xs text-muted-foreground">
                给这个账号直接加积分，记入流水「人工入账」。
              </p>
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  reviewCredit();
                }}
              >
                <fieldset
                  disabled={busy}
                  className="grid items-start gap-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                >
                  <div className="grid gap-1">
                    <Input
                      id="credit-amount"
                      aria-label="积分数量"
                      placeholder="积分数量"
                      inputMode="decimal"
                      aria-invalid={creditErr?.field === "credits" || undefined}
                      value={credits}
                      onChange={(event) => {
                        setCredits(event.target.value);
                        setCreditErr(null);
                      }}
                    />
                    {creditErr?.field === "credits" && (
                      <span className="text-xs text-destructive">{creditErr.text}</span>
                    )}
                  </div>
                  <div className="grid gap-1">
                    <Input
                      id="credit-reason"
                      aria-label="入账说明"
                      placeholder="说明，例如 部门预算 11 月"
                      maxLength={500}
                      aria-invalid={creditErr?.field === "reason" || undefined}
                      value={reason}
                      onChange={(event) => {
                        setReason(event.target.value);
                        setCreditErr(null);
                      }}
                    />
                    {creditErr?.field === "reason" && (
                      <span className="text-xs text-destructive">{creditErr.text}</span>
                    )}
                  </div>
                  <Button type="submit" disabled={busy}>
                    <ArrowDownToLine className="size-4" />
                    发放
                  </Button>
                </fieldset>
              </form>
            </section>
          </div>
        )}
        <Tabs value={accountView} onValueChange={(view) => openAccountView(view as AccountView)}>
          <TabsList aria-label="账户明细" className="mb-5 max-w-full">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="runs">运行消耗</TabsTrigger>
            <TabsTrigger value="ledger">流水</TabsTrigger>
          </TabsList>
          {/* 首次访问才挂载；保留已访问面板的游标、筛选、错误和重试状态。 */}
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
            {statement ? (
              <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatBox
                  label="可用"
                  title={`${creditsExact(statement.balance.availableMicroCredits)} 积分`}
                >
                  {creditsBalance(statement.balance.availableMicroCredits)}
                </StatBox>
                <StatBox
                  label="冻结中"
                  title={`${creditsExact(statement.balance.reservedMicroCredits)} 积分`}
                >
                  {creditsAmount(statement.balance.reservedMicroCredits)}
                </StatBox>
                <StatBox label="本月已用">
                  {statement.month ? creditsAmount(statement.month.usedMicroCredits) : "—"}
                </StatBox>
                <StatBox label="月度上限">
                  {statement.month?.limitPending ? (
                    <span className="text-warning-text">待按积分重设</span>
                  ) : statement.month?.limitMicroCredits == null ? (
                    "不限"
                  ) : statement.month.limitMicroCredits === "0" ? (
                    "禁止消费"
                  ) : (
                    creditsAmount(statement.month.limitMicroCredits)
                  )}
                </StatBox>
              </dl>
            ) : loading ? (
              <p className="py-5 text-sm text-muted-foreground">载入中…</p>
            ) : admin && !accountId ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Wallet className="mx-auto mb-3 size-8" />
                选择账号查看余额与流水
              </div>
            ) : null}
            {statement?.month?.limitPending && (
              <p className="mb-4 flex items-start gap-2 rounded-xl border border-[#EBCB91] bg-[#FFFBF2] px-3.5 py-2.5 text-sm text-warning-text">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                旧上限还没按积分重设，设置前这个账号不能发起运行。
              </p>
            )}
            {statement && visitedAccount.includes("overview") && (
              <ChargeSummary
                key={admin ? `${accountId}:${accountRange}` : "self"}
                accountId={admin ? accountId : undefined}
                initialRange={accountRange}
                activeDrill={drill}
                onDrill={(next) => {
                  setDrill(next);
                  openAccountView("runs");
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="runs" forceMount className="data-[state=inactive]:hidden">
            {statement && visitedAccount.includes("runs") && (
              <RunChargeList
                accountId={admin ? accountId : undefined}
                drill={drill}
                onClearDrill={() => setDrill(null)}
              />
            )}
            {!statement && (
              <p className="py-5 text-sm text-muted-foreground">
                {loading
                  ? "载入中…"
                  : admin && !accountId
                    ? "选择账号查看运行消耗"
                    : error
                      ? "暂时无法载入账户"
                      : "暂无账户数据"}
              </p>
            )}
          </TabsContent>
          <TabsContent value="ledger">
            {statement && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">账户流水</h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="刷新流水"
                    aria-label="刷新流水"
                    disabled={loading || busy}
                    onClick={() => void load()}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </div>
                {statement.items.length === 0 ? (
                  <p className="py-5 text-sm text-muted-foreground">暂无流水</p>
                ) : (
                  <LedgerTable items={statement.items} />
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
            {!statement && (
              <p className="py-5 text-sm text-muted-foreground">
                {loading
                  ? "载入中…"
                  : admin && !accountId
                    ? "选择账号查看账户流水"
                    : error
                      ? "暂时无法载入账户"
                      : "暂无账户数据"}
              </p>
            )}
          </TabsContent>
        </Tabs>
      </div>
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

function StatBox({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card px-[18px] py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-display text-2xl font-semibold" title={title}>
        {children}
      </dd>
    </div>
  );
}
