"use client";

import { SettingsShell } from "@/components/settings-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect as Select } from "@/components/ui/native-select";
import {
  type UsageBucket,
  type UsageTotals,
  formatUsd,
} from "@/lib/modules/usage/domain/aggregate";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface UsageData {
  days: number;
  scope: "self" | "all";
  canViewAll: boolean;
  queue: { pending: number; running: number };
  totals: UsageTotals;
  byAgent: UsageBucket[];
  byDay: UsageBucket[];
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
        {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** 简易横向条:不引图表库,够看趋势就行。 */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 flex-1 rounded bg-muted">
      <div className="h-full rounded bg-foreground/40" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * 用量看板。
 *
 * 【为什么 scope 由外部固定,而不是页内切换】改造后「我的用量」和「全平台用量」
 * 是两个不同的页面(个人区 / 管理员区),范围由所在位置决定。
 * 再留一个页内下拉,等于同一个页面能变成另一个页面 —— 面包屑和地址都会说谎。
 */
export function UsageView({ scope = "self" }: { scope?: "self" | "all" }) {
  const [days, setDays] = useState(7);
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
  const maxAsstCost = Math.max(1, ...(data?.byAgent.map((b) => b.costMicroUsd) ?? [0]));
  const t = data?.totals;
  const successRate = t && t.runs > 0 ? Math.round((t.succeeded / t.runs) * 100) : null;

  return (
    <SettingsShell
      area={scope === "all" ? "admin" : "personal"}
      title={scope === "all" ? "全平台用量" : "我的用量"}
      subtitle={`${scope === "all" ? "所有用户的会话" : "仅我的会话"} · 最近 ${data?.days ?? days} 天`}
      actions={
        <Select
          className="h-7 w-auto text-xs"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              最近 {d} 天
            </option>
          ))}
        </Select>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
            <Card className="border-blue-500/20 bg-blue-500/10">
              <CardContent className="px-3 py-2 text-xs">
                队列:{data.queue.pending} 个排队 · {data.queue.running} 个在跑
                {data.queue.pending > 10 && " —— 积压偏高,考虑加 worker"}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">按智能体</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.byAgent.length === 0 && (
                <p className="text-xs text-muted-foreground">窗口内没有运行记录</p>
              )}
              {data.byAgent.map((b) => (
                <div key={b.key} className="flex items-center gap-3 text-xs">
                  <span className="w-32 truncate">{b.label}</span>
                  <Bar value={b.costMicroUsd} max={maxAsstCost} />
                  <span className="w-16 text-right font-mono">{formatUsd(b.costMicroUsd)}</span>
                  <Badge
                    variant={b.failed > 0 ? "destructive" : "secondary"}
                    className="w-24 justify-center text-[10px]"
                  >
                    {b.runs} 次 · {b.failed > 0 ? `${b.failed} 失败` : "全成功"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">按天(UTC)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.byDay.length === 0 && (
                <p className="text-xs text-muted-foreground">窗口内没有运行记录</p>
              )}
              {data.byDay.map((b) => (
                <div key={b.key} className="flex items-center gap-3 text-xs">
                  <span className="w-24 font-mono">{b.key}</span>
                  <Bar value={b.costMicroUsd} max={maxDayCost} />
                  <span className="w-16 text-right font-mono">{formatUsd(b.costMicroUsd)}</span>
                  <span className="w-16 text-right text-muted-foreground">{b.runs} 次</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </SettingsShell>
  );
}
