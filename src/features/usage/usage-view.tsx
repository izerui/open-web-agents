"use client";

import {
  type UsageBucket,
  type UsageTotals,
  formatUsd,
} from "@/lib/modules/usage/domain/aggregate";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface UsageData {
  days: number;
  scope: "self" | "all";
  canViewAll: boolean;
  queue: { pending: number; running: number };
  totals: UsageTotals;
  byAssistant: UsageBucket[];
  byDay: UsageBucket[];
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-black/10 p-3 dark:border-white/15">
      <p className="text-xs opacity-55">{label}</p>
      <p className="font-semibold text-lg">{value}</p>
      {hint && <p className="text-xs opacity-45">{hint}</p>}
    </div>
  );
}

/** 简易横向条:不引图表库,够看趋势就行。 */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 flex-1 rounded bg-black/5 dark:bg-white/10">
      <div className="h-full rounded bg-black/40 dark:bg-white/50" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function UsageView() {
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState<"self" | "all">("self");
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/usage?days=${days}&scope=${scope}`);
      const d = (await res.json()) as UsageData & { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxDayCost = Math.max(1, ...(data?.byDay.map((b) => b.costMicroUsd) ?? [0]));
  const maxAsstCost = Math.max(1, ...(data?.byAssistant.map((b) => b.costMicroUsd) ?? [0]));
  const t = data?.totals;
  const successRate = t && t.runs > 0 ? Math.round((t.succeeded / t.runs) * 100) : null;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-lg">用量与成本</h1>
          <p className="text-xs opacity-55">
            {data?.scope === "all" ? "全平台" : "仅我的会话"} · 最近 {data?.days ?? days} 天
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <select
            className="rounded border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                最近 {d} 天
              </option>
            ))}
          </select>
          {data?.canViewAll && (
            <select
              className="rounded border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
              value={scope}
              onChange={(e) => setScope(e.target.value as "self" | "all")}
            >
              <option value="self">仅我的</option>
              <option value="all">全平台</option>
            </select>
          )}
          <Link href="/" className="underline opacity-60 hover:opacity-100">
            工作台
          </Link>
          <Link href="/settings" className="underline opacity-60 hover:opacity-100">
            设置
          </Link>
        </div>
      </header>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {t && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="总花费" value={formatUsd(t.costMicroUsd)} />
            <Stat
              label="运行次数"
              value={String(t.runs)}
              hint={successRate === null ? undefined : `成功率 ${successRate}%`}
            />
            <Stat label="输入 tokens" value={t.inputTokens.toLocaleString()} />
            <Stat label="输出 tokens" value={t.outputTokens.toLocaleString()} />
          </div>

          {(data.queue.pending > 0 || data.queue.running > 0) && (
            <p className="rounded bg-blue-500/10 px-3 py-2 text-xs">
              队列:{data.queue.pending} 个排队 · {data.queue.running} 个在跑
              {data.queue.pending > 10 && " —— 积压偏高,考虑加 worker"}
            </p>
          )}

          <section className="space-y-2">
            <h2 className="font-medium text-sm">按助手</h2>
            {data.byAssistant.length === 0 && (
              <p className="text-xs opacity-40">窗口内没有运行记录</p>
            )}
            {data.byAssistant.map((b) => (
              <div key={b.key} className="flex items-center gap-3 text-xs">
                <span className="w-32 truncate">{b.label}</span>
                <Bar value={b.costMicroUsd} max={maxAsstCost} />
                <span className="w-16 text-right font-mono">{formatUsd(b.costMicroUsd)}</span>
                <span className="w-24 text-right opacity-55">
                  {b.runs} 次 · {b.failed > 0 ? `${b.failed} 失败` : "全成功"}
                </span>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="font-medium text-sm">按天(UTC)</h2>
            {data.byDay.map((b) => (
              <div key={b.key} className="flex items-center gap-3 text-xs">
                <span className="w-24 font-mono">{b.key}</span>
                <Bar value={b.costMicroUsd} max={maxDayCost} />
                <span className="w-16 text-right font-mono">{formatUsd(b.costMicroUsd)}</span>
                <span className="w-16 text-right opacity-55">{b.runs} 次</span>
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
