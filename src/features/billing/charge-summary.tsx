"use client";

import { LoadError } from "@/components/load-error";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { CardHead, tb } from "@/features/settings/space-page";
import { errorText, fetchJson } from "@/lib/fetch-json";
import {
  CHARGE_SOURCE_LABEL,
  type ChargeSummaryRow,
  type SummaryDimension,
  type SummaryWindow,
  isChargeSource,
  totalOf,
} from "@/lib/modules/billing/domain/charge-summary";
import { creditsAmount, creditsExact } from "@/lib/modules/billing/domain/credits-display";
import { cn } from "@/lib/utils";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { creditsToYuan } from "./billing-display";

export const WINDOW_LABEL: Record<SummaryWindow, string> = {
  this_month: "本月",
  last_month: "上月",
  "30d": "近 30 天",
  "90d": "近 90 天",
};

const DIMENSION_LABEL: Record<SummaryDimension, string> = {
  source: "按来源",
  agent: "按智能体",
  key: "按 API Key",
  account: "按账号",
};

/** 运行明细的筛选:从汇总的某一行点进来 */
export interface ChargeDrill {
  label: string;
  params: Record<string, string>;
}

/** 一行的显示名;没有 key 的组按维度给出说明 */
function rowLabel(by: SummaryDimension, r: ChargeSummaryRow): string {
  if (by === "source") return isChargeSource(r.key) ? CHARGE_SOURCE_LABEL[r.key] : "其他";
  if (by === "agent") return r.key === null ? "已删除的智能体" : (r.name ?? r.key);
  if (by === "key") {
    if (r.key === null) return "不经 API Key（网页、智能体设计器、评测）";
    return r.name ? `${r.name}` : `已删除的 Key(${r.key.slice(0, 8)})`;
  }
  return r.name ?? r.key ?? "未知账号";
}

/** 点开某一行时传给运行明细的筛选参数 */
function drillParams(by: SummaryDimension, r: ChargeSummaryRow): Record<string, string> | null {
  if (by === "source") return { source: r.key ?? "other" };
  if (by === "agent") return { agentId: r.key ?? "none" };
  if (by === "key") return { apiKeyId: r.key ?? "none" };
  return null;
}

const amount = (micro: string) => (
  <span title={`${creditsExact(micro)} 积分`}>{creditsAmount(micro)}</span>
);

/**
 * 消耗汇总:选定时间窗口内的积分消耗按来源、智能体、API Key 归组。
 * 合计口径与月度额度一致(冻结中 + 净扣 + 欠额),"本月"的合计等于"本月已用"。
 * platform = 管理员看全平台,维度换成来源、智能体、账号
 */
export function ChargeSummary({
  accountId,
  platform = false,
  onDrill,
  onSelectAccount,
  initialRange = "this_month",
  activeDrill,
  defaultBy,
  onShowPending,
}: {
  /** 全平台:欠额统计卡上的「看待核对」 */
  onShowPending?: () => void;
  /** 当前明细正在看的那一项:汇总里对应的行高亮 */
  activeDrill?: ChargeDrill | null;
  /** 默认维度(全平台默认按账号) */
  defaultBy?: SummaryDimension;
  accountId?: string;
  platform?: boolean;
  onDrill?: (drill: ChargeDrill) => void;
  /** 点账号时把当前时间范围一起带过去,账号汇总与明细沿用它,才能核对刚才那笔 */
  onSelectAccount?: (id: string, range: SummaryWindow) => void;
  /** 打开时的时间范围(从全平台汇总点账号进来时沿用那边的) */
  initialRange?: SummaryWindow;
}) {
  const dimensions: SummaryDimension[] = platform
    ? ["account", "source", "agent"]
    : ["source", "agent", "key"];
  const [by, setBy] = useState<SummaryDimension>(defaultBy ?? "source");
  const [range, setRange] = useState<SummaryWindow>(initialRange);
  const [rows, setRows] = useState<ChargeSummaryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const params = new URLSearchParams({ by, window: range });
    if (platform) params.set("scope", "all");
    else if (accountId) params.set("accountId", accountId);
    try {
      const r = await fetchJson<{ rows: ChargeSummaryRow[] }>(`/api/billing/summary?${params}`);
      if (mine !== seq.current) return;
      setRows(r.rows);
      setError("");
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [by, range, platform, accountId]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const total = rows ? totalOf(rows) : null;
  /** 这一行是不是明细正在看的那一项(维度取值与时间范围都对得上) */
  const isActive = (r: ChargeSummaryRow) => {
    const p = drillParams(by, r);
    if (!activeDrill || !p) return false;
    const want: Record<string, string> = { ...p, window: range };
    const got = activeDrill.params;
    return (
      Object.keys(want).length === Object.keys(got).length &&
      Object.entries(want).every(([k, v]) => got[k] === v)
    );
  };
  const clickable = (r: ChargeSummaryRow) =>
    by === "account" ? Boolean(r.key && onSelectAccount) : Boolean(onDrill);
  const open = (r: ChargeSummaryRow) => {
    if (by === "account") {
      if (r.key) onSelectAccount?.(r.key, range);
      return;
    }
    const params = drillParams(by, r);
    if (params)
      onDrill?.({
        label: `${WINDOW_LABEL[range]}的${rowLabel(by, r)}`,
        params: { ...params, window: range },
      });
  };

  const stats = platform && total && (
    <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="platform-billing-stats">
      <SummaryStat label="实际扣除（积分）" hint={`约 ¥ ${creditsToYuan(total.chargedMicro)}`}>
        {amount(total.chargedMicro)}
      </SummaryStat>
      <SummaryStat label="运行次数" hint={WINDOW_LABEL[range]}>
        {total.runs.toLocaleString("zh-CN")}
      </SummaryStat>
      <SummaryStat
        label="欠额（积分）"
        tone={total.owedMicro !== "0" ? "bad" : undefined}
        hint={
          onShowPending ? (
            <button
              type="button"
              className="min-h-8 underline underline-offset-2"
              onClick={onShowPending}
            >
              看待核对
            </button>
          ) : undefined
        }
      >
        {amount(total.owedMicro)}
      </SummaryStat>
      <SummaryStat label="冻结中（积分）" hint="运行结束后按实际用量结算">
        {amount(total.reservedMicro)}
      </SummaryStat>
    </dl>
  );

  return (
    <>
      {stats}
      <section
        className="mb-4 rounded-2xl border border-border bg-card"
        aria-label={platform ? "全平台消耗汇总" : "消耗汇总"}
      >
        <CardHead
          title={platform ? "全平台消耗汇总" : "消耗汇总"}
          meta="合计 = 实际扣除 + 欠额 + 冻结中"
          actions={
            <>
              <fieldset
                className="inline-flex rounded-full bg-secondary p-[3px]"
                aria-label="汇总维度"
              >
                {dimensions.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={by === d}
                    className={cn(
                      "h-[30px] rounded-full px-3.5 text-[13px] text-muted-foreground max-md:h-10",
                      by === d && "bg-card font-semibold text-foreground shadow-xs",
                    )}
                    onClick={() => setBy(d)}
                  >
                    {DIMENSION_LABEL[d]}
                  </button>
                ))}
              </fieldset>
              <NativeSelect
                aria-label="时间范围"
                value={range}
                onChange={(e) => setRange(e.target.value as SummaryWindow)}
                className="w-auto min-w-28"
              >
                {(Object.keys(WINDOW_LABEL) as SummaryWindow[]).map((w) => (
                  <option key={w} value={w}>
                    {WINDOW_LABEL[w]}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="ghost"
                size="icon-sm"
                title="刷新消耗汇总"
                aria-label="刷新消耗汇总"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              </Button>
            </>
          }
        />
        {error && (
          <div className="px-[22px] pb-4">
            <LoadError compact what="消耗汇总" message={error} onRetryAction={() => void load()} />
          </div>
        )}
        {!rows || rows.length === 0 ? (
          error ? null : (
            <p className="px-[22px] pb-5 text-sm text-muted-foreground">
              {loading || !rows ? "载入中…" : "这段时间没有运行"}
            </p>
          )
        ) : (
          <div className={tb.wrap}>
            <table className={cn(tb.table, "min-w-[640px]")} data-testid="charge-summary">
              <caption className="sr-only">消耗汇总</caption>
              <thead>
                <tr>
                  {[
                    DIMENSION_LABEL[by].replace("按", "").trim(),
                    "次数",
                    "实际扣除",
                    "欠额",
                    "冻结中",
                    "合计",
                  ].map((t, i) => (
                    <th
                      scope="col"
                      key={t}
                      className={cn(tb.th, i === 0 ? tb.first : tb.right, i === 5 && tb.last)}
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.key ?? "none"}
                    data-testid="charge-summary-row"
                    aria-selected={isActive(r) || undefined}
                    className={cn(
                      clickable(r) && "cursor-pointer hover:[&>td]:bg-[#FAF9F6]",
                      isActive(r) && tb.selRow,
                    )}
                    onClick={clickable(r) ? () => open(r) : undefined}
                    onKeyDown={clickable(r) ? (e) => e.key === "Enter" && open(r) : undefined}
                  >
                    <td className={cn(tb.td, tb.first, "min-w-32 max-w-xs break-words")}>
                      {clickable(r) ? (
                        <button
                          type="button"
                          className="inline-flex min-h-8 items-center gap-1.5 text-left hover:underline"
                          title="查看这部分的运行明细"
                          onClick={(e) => {
                            e.stopPropagation();
                            open(r);
                          }}
                        >
                          {rowLabel(by, r)}
                          <ChevronRight className="size-3.5 text-muted-foreground" />
                        </button>
                      ) : (
                        rowLabel(by, r)
                      )}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>{r.runs}</td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(r.chargedMicro)}
                    </td>
                    <td
                      className={cn(
                        tb.td,
                        tb.num,
                        tb.right,
                        "font-mono",
                        r.owedMicro !== "0" && "text-destructive",
                      )}
                    >
                      {amount(r.owedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(r.reservedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, tb.last, "font-mono font-semibold")}>
                      {amount(r.usedMicro)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {total && (
                <tfoot>
                  <tr
                    className="font-semibold [&>td]:bg-[#FAF9F6]"
                    data-testid="charge-summary-total"
                  >
                    <td className={cn(tb.td, tb.first)}>合计（{WINDOW_LABEL[range]}）</td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>{total.runs}</td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(total.chargedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(total.owedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(total.reservedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, tb.last, "font-mono")}>
                      {amount(total.usedMicro)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function SummaryStat({
  label,
  hint,
  tone,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  tone?: "bad";
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card px-[18px] py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-all font-display text-2xl font-semibold",
          tone === "bad" && "text-destructive",
        )}
      >
        {children}
      </dd>
      {hint && <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}
