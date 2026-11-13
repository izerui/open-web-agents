"use client";

import { LoadError } from "@/components/load-error";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Banner, CardHead, EmptyState, SpacePage, StatCard } from "@/features/settings/space-page";
import { errorText, fetchJson } from "@/lib/fetch-json";
import {
  CHARGE_SOURCE_LABEL,
  type ChargeSummaryRow,
  isChargeSource,
} from "@/lib/modules/billing/domain/charge-summary";
import {
  creditsAmount,
  creditsBalance,
  creditsExact,
} from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry, WalletBalance } from "@/lib/modules/billing/ports";
import { hasCreditsAccount } from "@/lib/nav/routes";
import { useMe } from "@/lib/use-me";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BILLING_TABS,
  BILLING_TAB_LABEL,
  type BillingTab,
  billingTab,
  monthShare,
  shareOf,
} from "./billing-display";
import { type ChargeDrill, ChargeSummary } from "./charge-summary";
import { LedgerTable } from "./ledger-table";
import { PackagesPanel } from "./package-view";
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

/**
 * 账户 · 积分与套餐:概览 / 充值与订单 / 账户流水 / 运行消耗 四个页签,
 * 合并了原来的「用量与费用」与「充值与订单」两页。页签记在地址 ?tab= 里,刷新、分享都还在原处。
 * 管理员的 /admin/billing 仍用 BillingView(admin)。
 */
export function AccountBillingView() {
  const { me } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = billingTab(searchParams.get("tab"));
  // 首次打开才挂载,之后保留各页签的筛选、游标与错误状态
  const [visited, setVisited] = useState<BillingTab[]>([tab]);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<ChargeDrill | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    setVisited((v) => (v.includes(tab) ? v : [...v, tab]));
  }, [tab]);

  function openTab(next: BillingTab) {
    const q = new URLSearchParams(searchParams.toString());
    if (next === "overview") q.delete("tab");
    else q.set("tab", next);
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  }

  const load = useCallback(async (cursor?: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    try {
      const result = await fetchJson<Statement>(`/api/billing?${params}`);
      if (mine !== seq.current) return;
      setStatement((prev) => ({
        ...result,
        month: result.month ?? prev?.month,
        items: cursor && prev ? [...prev.items, ...result.items] : result.items,
      }));
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  // 有邮箱写「X 的积分账户」,没有时写「你的积分账户」(不要「你 的」)
  const owner = me?.user?.email ? `${me.user.email.split("@")[0]} 的` : "你的";

  // 关闭登录的本地模式:匿名管理员不在账号表里,没有积分账户。给说明,不给「账号不存在」报错
  if (!hasCreditsAccount(me)) {
    return (
      <SpacePage side="account" title="积分与套餐" subtitle="本地模式下没有个人积分账户。">
        <div className="rounded-2xl border border-border bg-card">
          <EmptyState
            title="本地模式没有积分账户"
            action={
              <>
                <Button asChild variant="outline">
                  <Link href="/account/usage">看用量分析</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/account/prices">看模型价格</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/admin/billing">平台计费</Link>
                </Button>
              </>
            }
          >
            现在是关闭登录的本地模式，你以匿名管理员身份使用，运行不扣个人积分。
            要按账号充值和扣费，请开启登录后用注册的账号进入。
          </EmptyState>
        </div>
      </SpacePage>
    );
  }

  return (
    <SpacePage
      side="account"
      title="积分与套餐"
      subtitle={`${owner}积分账户。每次运行发起时先按模型冻结积分，结束后按实际用量扣除，多余的退回可用余额。`}
      actions={
        <Button onClick={() => openTab("packages")}>
          <Plus />
          充值
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={(v) => openTab(v as BillingTab)}>
        <div className="mb-4 overflow-x-auto overflow-y-hidden border-b border-border">
          <TabsList aria-label="积分与套餐" className="h-auto bg-transparent p-0">
            {BILLING_TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="h-11 flex-none rounded-none border-0 border-b-2 border-transparent px-3.5 text-sm font-normal text-muted-foreground data-[state=active]:border-foreground data-[state=active]:font-semibold data-[state=active]:text-foreground"
              >
                {BILLING_TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {error && !statement && (
          <LoadError what="积分账户" message={error} onRetryAction={() => void load()} />
        )}

        <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
          {visited.includes("overview") && (
            <Overview
              statement={statement}
              loading={loading}
              onOpenTab={openTab}
              onDrill={(d) => {
                setDrill(d);
                openTab("runs");
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="packages" forceMount className="data-[state=inactive]:hidden">
          {visited.includes("packages") && (
            <PackagesPanel onOpenAccount={() => openTab("overview")} />
          )}
        </TabsContent>
        <TabsContent value="ledger" forceMount className="data-[state=inactive]:hidden">
          {visited.includes("ledger") && (
            <section aria-label="账户流水" className="rounded-2xl border border-border bg-card">
              <CardHead
                title="账户流水"
                meta={
                  statement
                    ? `可用 ${creditsAmount(statement.balance.availableMicroCredits)}，冻结中 ${creditsAmount(statement.balance.reservedMicroCredits)}`
                    : undefined
                }
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => void load()}
                    aria-label="刷新流水"
                  >
                    <RefreshCw className="size-[15px]" />
                    刷新
                  </Button>
                }
              />
              {!statement ? (
                <p className="px-[22px] pb-5 text-sm text-muted-foreground">
                  {loading ? "载入中…" : "暂时无法载入账户"}
                </p>
              ) : statement.items.length === 0 ? (
                <p className="px-[22px] pb-5 text-sm text-muted-foreground">暂无流水</p>
              ) : (
                <>
                  <LedgerTable items={statement.items} />
                  <div className="flex justify-center p-3.5">
                    {statement.nextCursor ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loading}
                        onClick={() => void load(statement.nextCursor)}
                      >
                        {loading ? "载入中…" : "加载更早的"}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">没有更早的流水了</span>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </TabsContent>
        <TabsContent value="runs" forceMount className="data-[state=inactive]:hidden">
          {visited.includes("runs") && (
            <>
              <ChargeSummary
                activeDrill={drill}
                onDrill={(d) => {
                  setDrill(d);
                  requestAnimationFrame(() =>
                    document
                      .getElementById("run-charge-list")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                  );
                }}
              />
              <RunChargeList drill={drill} onClearDrill={() => setDrill(null)} showRunsLink />
            </>
          )}
        </TabsContent>
      </Tabs>
    </SpacePage>
  );
}

function Overview({
  statement,
  loading,
  onOpenTab,
  onDrill,
}: {
  statement: Statement | null;
  loading: boolean;
  onOpenTab: (tab: BillingTab) => void;
  onDrill: (drill: ChargeDrill) => void;
}) {
  const liveRuns = useLiveRunCount();
  if (!statement) {
    return loading ? <p className="py-5 text-sm text-muted-foreground">载入中…</p> : null;
  }
  const month = statement.month;
  const pct = monthShare(month);
  const live = liveRuns;
  return (
    <>
      {month?.limitPending && (
        <Banner tone="warn" icon={<AlertTriangle />}>
          <b>你的月度上限还是旧的额度，需要管理员按积分重新设置，设置前不能发起运行。</b>
          请联系管理员在「平台管理」的「账号」里为你设置积分上限。
        </Banner>
      )}
      <dl className="mb-4 grid grid-cols-1 gap-3.5 md:grid-cols-3">
        <StatCard
          label="可用"
          testId="balance-available"
          value={
            <span title={`${creditsExact(statement.balance.availableMicroCredits)} 积分`}>
              {creditsBalance(statement.balance.availableMicroCredits)}
            </span>
          }
          hint="积分长期有效，不清零"
        />
        <StatCard
          label="冻结中"
          testId="balance-reserved"
          value={
            <span title={`${creditsExact(statement.balance.reservedMicroCredits)} 积分`}>
              {creditsAmount(statement.balance.reservedMicroCredits)}
            </span>
          }
          hint={
            live && live.count > 0
              ? `${live.count}${live.more ? "+" : ""} 个运行进行中，结束后按实际用量结算`
              : "进行中的运行结束后按实际用量结算"
          }
        />
        <StatCard
          label="本月已用 / 月度上限"
          value={
            <>
              {month ? creditsAmount(month.usedMicroCredits) : "—"}
              <span className="font-sans text-base font-normal text-muted-foreground">
                {" "}
                / {month?.limitMicroCredits ? creditsAmount(month.limitMicroCredits) : "不限"}
              </span>
            </>
          }
          hint={
            pct === null
              ? "没有月度上限，只受可用余额约束"
              : `已用 ${pct}%，上限由管理员设置，超过后新运行会被拒绝`
          }
        >
          {pct !== null && (
            <dd className="mt-2 mb-1.5 h-1.5 overflow-hidden rounded-full bg-[#ECEAE3]">
              <span
                className={pct >= 80 ? "block h-full bg-warning" : "block h-full bg-success"}
                style={{ width: `${pct}%` }}
              />
            </dd>
          )}
        </StatCard>
      </dl>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-label="最近流水" className="rounded-2xl border border-border bg-card pb-1.5">
          <CardHead
            title="最近流水"
            actions={
              <Button variant="link" size="sm" onClick={() => onOpenTab("ledger")}>
                查看全部流水
              </Button>
            }
          />
          {statement.items.length === 0 ? (
            <p className="px-[22px] pb-5 text-sm text-muted-foreground">暂无流水</p>
          ) : (
            <LedgerTable items={statement.items.slice(0, 5)} compact />
          )}
        </section>
        <section
          aria-label="本月花在哪"
          className="rounded-2xl border border-border bg-card px-[22px] py-5 max-md:px-4"
        >
          <h2 className="text-base font-semibold">本月花在哪</h2>
          <p className="mb-3 text-xs text-muted-foreground">按来源，实际扣除</p>
          <MonthBySource onDrill={onDrill} />
          <Button variant="outline" size="sm" className="mt-1.5" onClick={() => onOpenTab("runs")}>
            看运行消耗明细
          </Button>
          <hr className="my-4 border-line-soft" />
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">积分不够了？</div>
              <div className="text-xs text-muted-foreground">
                买固定积分包，管理员人工确认后到账
              </div>
            </div>
            <Button size="sm" onClick={() => onOpenTab("packages")}>
              去充值
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}

/** 本月按来源的实际扣除;点一项直接下钻到运行消耗明细 */
function MonthBySource({ onDrill }: { onDrill: (drill: ChargeDrill) => void }) {
  const [rows, setRows] = useState<ChargeSummaryRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetchJson<{ rows: ChargeSummaryRow[] }>("/api/billing/summary?by=source&window=this_month")
      .then((r) => active && setRows(r.rows))
      .catch((err) => active && setError(errorText(err)));
    return () => {
      active = false;
    };
  }, []);

  if (error) return <p className="mb-2 text-xs text-destructive">没读到:{error}</p>;
  if (!rows) return <p className="mb-2 text-sm text-muted-foreground">载入中…</p>;
  if (rows.length === 0)
    return <p className="mb-2 text-sm text-muted-foreground">本月还没有运行</p>;
  // 条形按占本月合计的比例,和原型一致(不是按最大的一项归一)
  const total = rows.reduce((sum, r) => sum + BigInt(r.chargedMicro), 0n);
  return (
    <ul className="mb-2 space-y-2.5">
      {rows.map((r) => {
        const label = isChargeSource(r.key) ? CHARGE_SOURCE_LABEL[r.key] : "其他";
        return (
          <li key={r.key ?? "none"}>
            <button
              type="button"
              className="block w-full text-left"
              title={`查看「${label}」的运行明细`}
              onClick={() =>
                onDrill({
                  label: `本月的${label}`,
                  params: { source: r.key ?? "other", window: "this_month" },
                })
              }
            >
              <span className="flex justify-between text-sm">
                <span>{label}</span>
                <span className="tabular-nums">{creditsAmount(r.chargedMicro)}</span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[#ECEAE3]">
                <span
                  className="block h-full bg-[#8A857A]"
                  style={{ width: `${shareOf(r.chargedMicro, total.toString())}%` }}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 计费在自己名下、还没结束(排队或在跑)的运行数,写在「冻结中」下面;没读到就不写 */
function useLiveRunCount(): { count: number; more: boolean } | null {
  const [live, setLive] = useState<{ count: number; more: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    fetchJson<{ items: unknown[]; nextCursor?: string }>(
      "/api/runs?status=pending,running&limit=100",
    )
      .then((r) => active && setLive({ count: r.items.length, more: Boolean(r.nextCursor) }))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return live;
}
