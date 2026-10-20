"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount, creditsExact } from "@/lib/modules/billing/domain/credits-display";
import type { PendingChargeItem, PendingReason } from "@/lib/modules/billing/run-charge-ports";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const REASON: Record<PendingReason, { label: string; hint: string }> = {
  owed: { label: "欠款", hint: "余额不足未扣齐,充值后自动补扣" },
  usage_unknown: { label: "用量未知", hint: "运行过,但结算时没有拿到用量" },
  unpriced: { label: "无法完整计价", hint: "连本次运行主模型的价目都取不到,暂时无法计价" },
};
const REASONS = Object.keys(REASON) as PendingReason[];

type Counts = Record<PendingReason, number>;

/** 差额:欠款为还欠的;其余为空 */
function gap(c: PendingChargeItem): string {
  if (c.reason === "owed") return `欠 ${creditsAmount(c.owedMicro ?? "0")}`;
  return "—";
}

/**
 * 管理员:所有账号的待核对(暂记)计费记录,只读。
 * 处理操作(核销、退还、确认结清)涉及新的账务规则,尚未提供。
 */
export function PendingCharges({ onSelectAccount }: { onSelectAccount?: (id: string) => void }) {
  const [reason, setReason] = useState<PendingReason | "">("");
  const [items, setItems] = useState<PendingChargeItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const mine = ++seq.current;
      setLoading(true);
      const params = new URLSearchParams({ limit: "50" });
      if (reason) params.set("reason", reason);
      if (cursor) params.set("cursor", cursor);
      try {
        const r = await fetchJson<{
          items: PendingChargeItem[];
          nextCursor?: string;
          counts: Counts;
        }>(`/api/admin/billing-pending?${params}`);
        if (mine !== seq.current) return;
        setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNext(r.nextCursor);
        setCounts(r.counts);
        setError("");
      } catch (err) {
        if (mine === seq.current) setError(errorText(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [reason],
  );
  useEffect(() => {
    setItems([]);
    void load();
  }, [load]);

  const total = counts ? REASONS.reduce((n, r) => n + counts[r], 0) : 0;
  return (
    <section className="mb-6 space-y-3 border-b pb-5" aria-label="待核对计费">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">待核对(所有账号)</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          title="刷新待核对"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <fieldset className="flex flex-wrap gap-1" aria-label="按原因筛选">
        {(["", ...REASONS] as const).map((r) => (
          <Button
            key={r || "all"}
            aria-pressed={reason === r}
            size="sm"
            variant={reason === r ? "secondary" : "ghost"}
            className="h-7 text-xs"
            onClick={() => setReason(r)}
          >
            {r ? REASON[r].label : "全部"} {counts ? (r ? counts[r] : total) : ""}
          </Button>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        {reason ? REASON[reason].hint : "这里只列出,不提供核销、退还或确认结清等处理操作。"}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {items.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          {loading ? "载入中…" : "没有待核对的记录"}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="pending-charges">
            <caption className="sr-only">待核对计费记录</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                {["时间", "账号", "智能体", "原因", "应扣", "实际扣除", "差额"].map((t) => (
                  <th scope="col" key={t} className="px-2 py-2">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.runId} className="border-b align-top" data-testid="pending-charge">
                  <td className="whitespace-nowrap px-2 py-2">
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                  <td className="max-w-48 break-all px-2 py-2">
                    {onSelectAccount ? (
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        title="查看这个账号的余额与流水"
                        onClick={() => onSelectAccount(c.accountId)}
                      >
                        {c.accountEmail ?? `已删除的账号 ${c.accountId}`}
                      </button>
                    ) : (
                      (c.accountEmail ?? `已删除的账号 ${c.accountId}`)
                    )}
                  </td>
                  <td className="min-w-28 break-words px-2 py-2">
                    {c.agentName ?? "已删除的智能体"}
                    <p className="mt-1 break-all text-muted-foreground">{c.runId}</p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2" title={REASON[c.reason].hint}>
                    {REASON[c.reason].label}
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-2 font-mono"
                    title={`${creditsExact(c.estimatedMicro ?? "0")} 积分`}
                  >
                    {creditsAmount(c.estimatedMicro ?? "0")}
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-2 font-mono"
                    title={`${creditsExact(c.chargedMicro ?? "0")} 积分`}
                  >
                    {creditsAmount(c.chargedMicro ?? "0")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">{gap(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(next)}>
          加载更早的
        </Button>
      )}
    </section>
  );
}
