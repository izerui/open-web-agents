"use client";

import { LoadError } from "@/components/load-error";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
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
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
    if (r.key === null) return "不经 API Key(网页、AI 编辑、评测)";
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
}: {
  accountId?: string;
  platform?: boolean;
  onDrill?: (drill: ChargeDrill) => void;
  /** 点账号时把当前时间范围一起带过去,账号汇总与明细沿用它,才能核对刚才那笔 */
  onSelectAccount?: (id: string, range: SummaryWindow) => void;
  /** 打开时的时间范围(从全平台汇总点账号进来时沿用那边的) */
  initialRange?: SummaryWindow;
}) {
  const dimensions: SummaryDimension[] = platform
    ? ["source", "agent", "account"]
    : ["source", "agent", "key"];
  const [by, setBy] = useState<SummaryDimension>("source");
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
        label: `${WINDOW_LABEL[range]} · ${rowLabel(by, r)}`,
        params: { ...params, window: range },
      });
  };

  return (
    <section className="mb-6" aria-label={platform ? "全平台消耗汇总" : "消耗汇总"}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{platform ? "全平台消耗汇总" : "消耗汇总"}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex rounded-md border p-0.5" aria-label="汇总维度">
            {dimensions.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={by === d}
                className={cn(
                  "rounded px-2 py-1 text-xs",
                  by === d ? "bg-muted font-medium" : "text-muted-foreground",
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
            className="h-8 w-28 text-xs"
          >
            {(Object.keys(WINDOW_LABEL) as SummaryWindow[]).map((w) => (
              <option key={w} value={w}>
                {WINDOW_LABEL[w]}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="ghost"
            size="icon"
            title="刷新消耗汇总"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      {error && <LoadError compact what="消耗汇总" message={error} />}
      {!rows || rows.length === 0 ? (
        error ? null : (
          <p className="py-5 text-sm text-muted-foreground">
            {loading || !rows ? "载入中…" : "这段时间没有运行"}
          </p>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="charge-summary">
            <caption className="sr-only">消耗汇总</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                {[
                  DIMENSION_LABEL[by].replace("按", ""),
                  "次数",
                  "实际扣除",
                  "欠额",
                  "冻结中",
                  "合计",
                ].map((t) => (
                  <th scope="col" key={t} className="whitespace-nowrap px-2 py-3">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key ?? "none"} data-testid="charge-summary-row" className="border-b">
                  <td className="min-w-32 max-w-xs break-words px-2 py-3">
                    {clickable(r) ? (
                      <button
                        type="button"
                        className="text-left underline decoration-dotted underline-offset-4 hover:decoration-solid"
                        title="查看这部分的运行明细"
                        onClick={() => open(r)}
                      >
                        {rowLabel(by, r)}
                      </button>
                    ) : (
                      rowLabel(by, r)
                    )}
                  </td>
                  <td className="px-2 py-3 font-mono">{r.runs}</td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">
                    {amount(r.chargedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">{amount(r.owedMicro)}</td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">
                    {amount(r.reservedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono font-medium">
                    {amount(r.usedMicro)}
                  </td>
                </tr>
              ))}
            </tbody>
            {total && (
              <tfoot>
                <tr className="text-muted-foreground" data-testid="charge-summary-total">
                  <td className="px-2 py-3">合计</td>
                  <td className="px-2 py-3 font-mono">{total.runs}</td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">
                    {amount(total.chargedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">
                    {amount(total.owedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono">
                    {amount(total.reservedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-mono font-medium text-foreground">
                    {amount(total.usedMicro)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  );
}
