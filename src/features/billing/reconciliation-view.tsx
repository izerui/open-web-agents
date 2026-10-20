"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import type { ReconCategory, ReconLine } from "@/lib/modules/billing/domain/reconciliation";
import { formatYuan } from "@/lib/modules/capabilities/domain/pricing";
import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Line = ReconLine & { providerName: string | null };

/** 缺失或不完整的数据类别:只计条数(及能算的部分),不代表已核实为零 */
const GAPS: { key: ReconCategory; label: string }[] = [
  { key: "unpriced", label: "无法完整计价" },
  { key: "snapshot_provisional", label: "快照暂记" },
  { key: "snapshot_settled", label: "按快照结清" },
  { key: "usage_unknown", label: "用量未知" },
  { key: "no_usage_zero", label: "未观察到用量(按 0 结清)" },
  { key: "not_started", label: "未开始" },
  { key: "open", label: "进行中" },
];

const fmt = (n: number) => n.toLocaleString();

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function gapsText(l: Line): string {
  const parts = GAPS.filter((g) => l.counts[g.key] > 0).map((g) => `${g.label} ${l.counts[g.key]}`);
  const u = l.unpricedTokens;
  const unpriced = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (unpriced > 0) parts.push(`无法计价 token ${fmt(unpriced)}`);
  return parts.join(";") || "—";
}

function toCsv(lines: Line[]): string {
  const head = [
    "日期",
    "提供者",
    "运行数",
    "完整",
    ...GAPS.map((g) => g.label),
    "输入token",
    "输出token",
    "缓存读token",
    "缓存写token",
    "无法计价token",
    "成本估算(元)",
    "应扣(积分)",
    "实际扣除(积分)",
  ];
  const rows = lines.map((l) => {
    const u = l.unpricedTokens;
    return [
      l.day,
      l.providerName ?? "(无锁定价目)",
      l.runs,
      l.counts.complete,
      ...GAPS.map((g) => l.counts[g.key]),
      l.tokens.input,
      l.tokens.output,
      l.tokens.cacheRead,
      l.tokens.cacheWrite,
      u.input + u.output + u.cacheRead + u.cacheWrite,
      formatYuan(l.costMicro),
      creditsAmount(l.estimatedMicro),
      creditsAmount(l.chargedMicro),
    ];
  });
  return [head, ...rows]
    .map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

/** 管理员:对账(只读)。按提供者、日期汇总,供与上游账单核对 */
export function ReconciliationView() {
  const [to, setTo] = useState(() => ymd(new Date()));
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 6 * 86_400_000)));
  const [lines, setLines] = useState<Line[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ from, to });
    try {
      const r = await fetchJson<{ lines: Line[]; truncated: boolean }>(
        `/api/admin/billing-reconciliation?${params}`,
      );
      setLines(r.lines);
      setTruncated(r.truncated);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [from, to]);
  useEffect(() => {
    void load();
  }, [load]);

  function download() {
    if (!lines) return;
    const blob = new Blob([`\uFEFF${toCsv(lines)}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `对账_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="mb-6 space-y-3 border-b pb-5" aria-label="对账">
      <div className="flex flex-wrap items-end gap-2">
        <h2 className="mr-auto text-sm font-semibold">对账</h2>
        <label className="space-y-1 text-xs">
          <span>从</span>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span>到</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8" />
        </label>
        <Button
          variant="ghost"
          size="icon"
          title="刷新对账"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
        <Button variant="outline" size="sm" disabled={!lines?.length} onClick={download}>
          <Download className="size-4" />
          导出 CSV
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        成本估算按每次运行受理时锁定的价目版本、用成本单价计算,用于与上游账单核对;日期按数据库时钟。
        用量未知、未观察到用量、未开始、进行中只计条数,不计入估算,不代表已核实为零;
        无法完整计价与快照的运行只计入能算的部分。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {truncated && (
        <p className="text-xs text-warning">区间内运行太多,只汇总了最近的 50,000 次,请缩小区间。</p>
      )}
      {lines && lines.length === 0 && !error && (
        <p className="py-3 text-sm text-muted-foreground">区间内没有运行</p>
      )}
      {lines && lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="reconciliation">
            <caption className="sr-only">对账</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                {[
                  "日期",
                  "提供者",
                  "运行数",
                  "输入 / 输出 token",
                  "缓存读 / 写 token",
                  "成本估算(元)",
                  "应扣",
                  "实际扣除",
                  "未完整的数据",
                ].map((t) => (
                  <th scope="col" key={t} className="px-2 py-2">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr
                  key={`${l.day}-${l.providerId}`}
                  className="border-b align-top"
                  data-testid="recon-line"
                >
                  <td className="whitespace-nowrap px-2 py-2">{l.day}</td>
                  <td className="px-2 py-2">{l.providerName ?? "(无锁定价目)"}</td>
                  <td className="px-2 py-2 font-mono">
                    {l.runs}
                    <p className="text-muted-foreground">完整 {l.counts.complete}</p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {fmt(l.tokens.input)} / {fmt(l.tokens.output)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {fmt(l.tokens.cacheRead)} / {fmt(l.tokens.cacheWrite)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {formatYuan(l.costMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {creditsAmount(l.estimatedMicro)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    {creditsAmount(l.chargedMicro)}
                  </td>
                  <td className="min-w-48 px-2 py-2">{gapsText(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
