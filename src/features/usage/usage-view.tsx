"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { LoadError } from "@/components/load-error";
import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Banner, CardHead, SpacePage, StatCard, tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import {
  type UsageBucket,
  type UsageTotals,
  formatUsd,
} from "@/lib/modules/usage/domain/aggregate";
import type { PublicCreditEstimate } from "@/lib/modules/usage/domain/public-estimate";
import { cn } from "@/lib/utils";
import { ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { barWidths, compactCount, dayTicks, fillDays, successRate } from "./usage-display";

interface RunDetail {
  runId: string;
  agentId: string;
  agentName?: string;
  status: string;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  at: number;
  estimatedCredits: PublicCreditEstimate;
  estimateSource: "run_snapshot" | "run_price_version" | "current_price";
}

interface UsageData {
  days: number;
  scope: "self" | "all";
  canViewAll: boolean;
  queue: { pending: number; running: number };
  totals: UsageTotals;
  byAgent: UsageBucket[];
  byDay: UsageBucket[];
  runs?: RunDetail[];
  creditEstimateNote?: string;
}

const WINDOWS = [1, 7, 30, 90] as const;

const RUN_STATUS: Record<
  string,
  { label: string; variant: "success" | "destructive" | "outline" }
> = {
  success: { label: "成功", variant: "success" },
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
};

/**
 * 用量分析。
 *
 * 【为什么 scope 由外部固定,而不是页内切换】「我的用量」和「全平台用量」
 * 是两个不同的页面(账户 / 平台管理),范围由所在位置决定。
 * 个人页直接用 AppShell(SpacePage);平台页仍在 SpaceShell 里,阶段 7 再换。
 */
export function UsageView({ scope = "self" }: { scope?: "self" | "all" }) {
  const [days, setDays] = useState(30);
  const windowPicker = <WindowPicker days={days} onChange={setDays} />;
  const body = <UsageContent scope={scope} days={days} />;
  if (scope === "all") {
    return (
      <SpaceShell
        area="admin"
        title="全平台 token 用量"
        subtitle="所有用户的运行,按 UTC 日期统计"
        actions={windowPicker}
      >
        {body}
      </SpaceShell>
    );
  }
  return (
    <SpacePage
      side="account"
      title="用量分析"
      subtitle="你名下运行的 token 用量与模型成本估算，按 UTC 日期统计。"
      actions={windowPicker}
    >
      {body}
    </SpacePage>
  );
}

function WindowPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <fieldset
      className="inline-flex max-w-full rounded-full bg-secondary p-[3px]"
      aria-label="时间窗"
    >
      {WINDOWS.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={days === d}
          onClick={() => onChange(d)}
          className={cn(
            "h-[30px] rounded-full px-3.5 text-[13px] whitespace-nowrap text-muted-foreground max-md:h-10 max-md:px-3",
            days === d && "bg-card font-semibold text-foreground shadow-xs",
          )}
        >
          最近 {d} 天
        </button>
      ))}
    </fieldset>
  );
}

function UsageContent({ scope, days }: { scope: "self" | "all"; days: number }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 快速切换时间窗口时,慢的旧响应不能覆盖新窗口的数据 */
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/usage?days=${days}&scope=${scope}`);
      const d = (await res.json()) as UsageData & { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      if (seq === seqRef.current) setData(d);
    } catch (e) {
      if (seq === seqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [days, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = data?.totals;
  const rate = t ? successRate(t) : null;
  const shown = data?.days ?? days;

  return (
    <div aria-busy={loading}>
      <Banner icon={<Info />}>
        <span data-testid="usage-billing-note">
          这里是按模型价目估算的成本（美元），用来看用量趋势；<b>实际扣费以积分页为准</b>，见
          <Link
            className="ml-1 underline decoration-[#C9C4B8] underline-offset-[3px]"
            href={scope === "all" ? "/admin/billing" : "/account/billing?tab=runs"}
          >
            {scope === "all" ? "计费" : "积分与套餐的运行消耗"}
          </Link>
          。
        </span>
      </Banner>

      {error && <LoadError what="用量" message={error} onRetryAction={() => void load()} />}

      {loading && !data && (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      )}

      {t && data && (
        <>
          <dl className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="总花费（估算）"
              value={formatUsd(t.costMicroUsd)}
              hint="按模型价目估算，不含积分加价"
            />
            <StatCard
              label="运行次数"
              value={t.runs.toLocaleString()}
              hint={
                <>
                  {rate !== null && (
                    <>
                      成功率 <b className="text-success-text">{rate}%</b>
                    </>
                  )}
                  {rate !== null && "，"}现在排队 {data.queue.pending}、在跑 {data.queue.running}
                  {data.queue.pending > 10 && "，积压偏高，考虑加 worker"}
                </>
              }
            />
            <StatCard
              label="输入 tokens"
              value={
                <span title={t.inputTokens.toLocaleString()}>{compactCount(t.inputTokens)}</span>
              }
              hint="含缓存读写，明细见下表"
            />
            <StatCard
              label="输出 tokens"
              value={
                <span title={t.outputTokens.toLocaleString()}>{compactCount(t.outputTokens)}</span>
              }
              hint={`最近 ${shown} 天`}
            />
          </dl>

          <div className="mb-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <ByAgent buckets={data.byAgent} />
            <ByDay buckets={data.byDay} days={shown} />
          </div>

          <RunDetailSection runs={data.runs ?? []} scope={scope} />
        </>
      )}
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="ml-auto flex gap-3.5 text-xs text-muted-foreground">
      {items.map(([label, color]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

const OK_COLOR = "#6F6A60";
const BAD_COLOR = "var(--destructive)";

function ByAgent({ buckets }: { buckets: UsageBucket[] }) {
  const max = Math.max(0, ...buckets.map((b) => b.runs));
  return (
    <section
      aria-label="按智能体"
      className="min-w-0 rounded-2xl border border-border bg-card px-[22px] py-5 max-md:px-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">按智能体</h2>
        <Legend
          items={[
            ["未失败", OK_COLOR],
            ["失败", BAD_COLOR],
          ]}
        />
      </div>
      {buckets.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">窗口内没有运行记录</p>
      ) : (
        <ul>
          {buckets.map((b) => {
            const w = barWidths(b, max);
            return (
              <li
                key={b.key}
                className="mt-3 grid grid-cols-[minmax(0,128px)_minmax(0,1fr)_104px] items-center gap-2.5 text-sm max-sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <AgentAvatar id={b.key} size={20} />
                  <span className="truncate" title={b.label}>
                    {b.label}
                  </span>
                </span>
                <span
                  className="flex h-3.5 overflow-hidden rounded bg-[#F1EFEA] max-sm:order-last max-sm:col-span-2"
                  title={`${b.label}:${b.runs} 次,失败 ${b.failed} 次`}
                >
                  <span className="flex h-full" style={{ width: `${w.total}%` }}>
                    <span className="h-full" style={{ width: `${w.ok}%`, background: OK_COLOR }} />
                    <span
                      className="h-full"
                      style={{ width: `${w.failed}%`, background: BAD_COLOR }}
                    />
                  </span>
                </span>
                <span className="text-right whitespace-nowrap tabular-nums">
                  {b.runs.toLocaleString()} 次
                  {b.failed > 0 && <span className="text-destructive">，{b.failed} 失败</span>}
                  <span className="block text-xs text-muted-foreground">
                    {formatUsd(b.costMicroUsd)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ByDay({ buckets, days }: { buckets: UsageBucket[]; days: number }) {
  const series = fillDays(buckets, days, Date.now());
  const max = Math.max(1, ...series.map((d) => d.runs));
  const ticks = dayTicks(series.map((d) => d.key));
  const empty = buckets.length === 0;
  return (
    <section
      aria-label="按天"
      className="min-w-0 rounded-2xl border border-border bg-card px-[22px] py-5 max-md:px-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">按天（UTC）</h2>
        <Legend
          items={[
            ["运行", OK_COLOR],
            ["其中失败", BAD_COLOR],
          ]}
        />
      </div>
      {empty ? (
        <p className="mt-3 text-sm text-muted-foreground">窗口内没有运行记录</p>
      ) : (
        <>
          <figure
            className={cn(
              "mt-3.5 flex h-[170px] items-end border-b border-border pb-0.5",
              series.length > 40 ? "gap-px" : "gap-[3px]",
            )}
            aria-label={`最近 ${days} 天每天运行次数`}
          >
            {series.map((d) => (
              <div
                key={d.key}
                className="group flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${d.key}:${d.runs} 次,失败 ${d.failed}`}
              >
                <i
                  className="block rounded-t-[3px] group-hover:opacity-80"
                  style={{ height: `${(d.failed / max) * 100}%`, background: BAD_COLOR }}
                />
                <i
                  className={cn(
                    "block min-h-0.5 group-hover:opacity-80",
                    d.failed === 0 && "rounded-t-[3px]",
                  )}
                  style={{ height: `${((d.runs - d.failed) / max) * 100}%`, background: OK_COLOR }}
                />
              </div>
            ))}
          </figure>
          <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
            {ticks.map((k, i) => (
              <span key={k}>
                {k.slice(5)}
                {i === ticks.length - 1 && "（今天）"}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function RunDetailSection({ runs, scope }: { runs: RunDetail[]; scope: "self" | "all" }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label="运行明细" className="rounded-2xl border border-border bg-card">
      <CardHead title="运行明细" meta="点一行展开每个模型的 tokens" />
      {runs.length === 0 ? (
        <p className="px-[22px] pb-5 text-sm text-muted-foreground">窗口内没有运行记录</p>
      ) : (
        <div className={tb.wrap}>
          <table className={cn(tb.table, "min-w-[760px]")}>
            <caption className="sr-only">运行明细</caption>
            <thead>
              <tr>
                <th scope="col" className={cn(tb.th, tb.first, "w-9")}>
                  <span className="sr-only">展开</span>
                </th>
                <th scope="col" className={tb.th}>
                  时间
                </th>
                <th scope="col" className={tb.th}>
                  智能体
                </th>
                <th scope="col" className={tb.th}>
                  状态
                </th>
                <th scope="col" className={cn(tb.th, tb.right)}>
                  模型数
                </th>
                <th scope="col" className={cn(tb.th, tb.right)}>
                  输入 / 输出
                </th>
                <th scope="col" className={cn(tb.th, tb.right, tb.last)}>
                  估算成本
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const est = r.estimatedCredits;
                const open = expanded.has(r.runId);
                const hasModels = est.models.length > 0;
                const st = RUN_STATUS[r.status] ?? { label: r.status, variant: "outline" as const };
                return (
                  <Fragment key={r.runId}>
                    <tr
                      className={cn(hasModels && tb.clickRow)}
                      onClick={() => hasModels && toggle(r.runId)}
                      onKeyDown={(e) => {
                        if (hasModels && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          toggle(r.runId);
                        }
                      }}
                      tabIndex={hasModels ? 0 : undefined}
                      aria-expanded={hasModels ? open : undefined}
                    >
                      <td className={cn(tb.td, tb.first)}>
                        {hasModels && (
                          <ChevronRight
                            className={cn(
                              "size-[15px] text-muted-foreground transition-transform",
                              open && "rotate-90",
                            )}
                          />
                        )}
                      </td>
                      <td className={cn(tb.td, tb.num)}>
                        <span title={new Date(r.at).toLocaleString()}>{shortTime(r.at)}</span>
                      </td>
                      <td className={tb.td}>
                        <span className="flex items-center gap-2">
                          <AgentAvatar id={r.agentId} size={22} />
                          <span className="max-w-48 truncate">{r.agentName ?? r.agentId}</span>
                        </span>
                      </td>
                      <td className={cn(tb.td, "whitespace-nowrap")}>
                        <Badge variant={st.variant}>{st.label}</Badge>
                        {!est.complete && hasModels && (
                          <Badge variant="warning" className="ml-1" title="有模型没回报用量">
                            部分
                          </Badge>
                        )}
                      </td>
                      <td className={cn(tb.td, tb.num, tb.right)}>{est.models.length}</td>
                      <td className={cn(tb.td, tb.num, tb.right)}>
                        {compactCount(r.inputTokens)} / {compactCount(r.outputTokens)}
                      </td>
                      <td className={cn(tb.td, tb.num, tb.right, tb.last)}>
                        {formatUsd(r.costMicroUsd)}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} className="border-b border-line-soft bg-[#FAF9F6] p-0">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr className="text-xs text-muted-foreground">
                                <th className="py-2 pr-3 pl-14 text-left font-medium">模型</th>
                                <th className="px-3 py-2 text-right font-medium">输入</th>
                                <th className="px-3 py-2 text-right font-medium">输出</th>
                                <th className="px-3 py-2 text-right font-medium">缓存读</th>
                                <th className="px-3 py-2 text-right font-medium">缓存写</th>
                                <th className="py-2 pr-[22px] pl-3 text-right font-medium">
                                  积分估算
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {est.models.map((m, i) => (
                                <tr
                                  key={`${r.runId}-${m.model ?? "unknown"}-${i}`}
                                  className="border-t border-line-soft"
                                >
                                  <td className="py-2 pr-3 pl-14 font-mono text-[12.5px]">
                                    {m.name}
                                    {m.version !== null && (
                                      <span className="ml-1 text-muted-foreground">
                                        v{m.version}
                                      </span>
                                    )}
                                  </td>
                                  {[
                                    m.inputTokens,
                                    m.outputTokens,
                                    m.cacheReadTokens,
                                    m.cacheWriteTokens,
                                  ].map((v, j) => (
                                    <td
                                      // biome-ignore lint/suspicious/noArrayIndexKey: 固定的四列
                                      key={j}
                                      className="px-3 py-2 text-right tabular-nums"
                                    >
                                      {v.toLocaleString()}
                                    </td>
                                  ))}
                                  <td className="py-2 pr-[22px] pl-3 text-right tabular-nums">
                                    {m.unpriced || m.microCredits === null ? (
                                      <span className="text-muted-foreground">未定价</span>
                                    ) : (
                                      creditsAmount(m.microCredits)
                                    )}
                                  </td>
                                </tr>
                              ))}
                              {!est.complete && hasModels && (
                                <tr className="border-t border-line-soft">
                                  <td
                                    colSpan={6}
                                    className="py-2 pr-3 pl-14 text-xs text-warning-text"
                                  >
                                    有模型调用没有回报用量，按已知部分统计。
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {scope === "self" && (
        <div className="flex justify-center p-3.5">
          <Link
            className="text-xs underline decoration-[#C9C4B8] underline-offset-[3px]"
            href="/developer/runs"
          >
            在运行记录里看全部运行
          </Link>
        </div>
      )}
    </section>
  );
}
