"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount, creditsExact } from "@/lib/modules/billing/domain/credits-display";
import type { RunChargeItem } from "@/lib/modules/billing/run-charge-ports";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const REJECT_TEXT = {
  insufficient_balance: "余额不足",
  account_limit_exceeded: "账号月度上限已满",
  key_limit_exceeded: "Key 月度上限已满",
  account_limit_pending: "旧月度上限待按积分重新设置",
} as const;

function stateText(c: RunChargeItem): string {
  if (c.state === "open") return c.mode === "live" ? "冻结中" : "进行中";
  if (c.state === "provisional") {
    if (c.owedMicro && c.owedMicro !== "0") {
      return `余额不足,欠 ${creditsAmount(c.owedMicro)} 积分,充值后自动补扣`;
    }
    const charged = BigInt(c.chargedMicro ?? "0");
    const estimated = BigInt(c.estimatedMicro ?? "0");
    // 费用往下修正后,已扣的多于应扣:暂不自动退款,标出来待核对
    if (charged > estimated) return `多扣 ${creditsAmount(charged - estimated)} 积分,待核对退还`;
    return "用量待补记,待核对";
  }
  if (c.owedMicro && c.owedMicro !== "0") return "余额不足补扣,待核对";
  if (c.incomplete) return "用量不完整,待核对";
  return "已结算";
}

/** 运行计费明细:每次运行的预计消耗与实际扣除 */
export function RunChargeList({ accountId }: { accountId?: string }) {
  const [items, setItems] = useState<RunChargeItem[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const mine = ++seq.current;
      setLoading(true);
      const params = new URLSearchParams({ limit: "50" });
      if (accountId) params.set("accountId", accountId);
      if (cursor) params.set("cursor", cursor);
      try {
        const r = await fetchJson<{ items: RunChargeItem[]; nextCursor?: string }>(
          `/api/billing/runs?${params}`,
        );
        if (mine !== seq.current) return;
        setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNext(r.nextCursor);
        setError("");
      } catch (err) {
        if (mine === seq.current) setError(errorText(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [accountId],
  );
  useEffect(() => {
    setItems([]);
    void load();
  }, [load]);

  return (
    <section className="mb-6" aria-label="运行计费明细">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">运行消耗</h2>
        <Button
          variant="ghost"
          size="icon"
          title="刷新运行消耗"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {items.length === 0 ? (
        <p className="py-5 text-sm text-muted-foreground">{loading ? "载入中…" : "暂无运行"}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">运行计费明细</caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                {["时间", "智能体", "模式", "预计消耗", "实际扣除", "状态"].map((t) => (
                  <th scope="col" key={t} className="px-2 py-3">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.runId} className="border-b align-top" data-testid="run-charge">
                  <td className="whitespace-nowrap px-2 py-3">
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                  <td className="min-w-32 max-w-xs break-words px-2 py-3">
                    {c.agentName ?? "已删除的智能体"}
                    <p className="mt-1 break-all text-muted-foreground">{c.runId}</p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    {c.mode === "trial" ? "试算" : "正式"}
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-3 font-mono"
                    title={c.estimatedMicro ? `${creditsExact(c.estimatedMicro)} 积分` : undefined}
                  >
                    {c.estimatedMicro === null ? "—" : creditsAmount(c.estimatedMicro)}
                  </td>
                  <td
                    className="whitespace-nowrap px-2 py-3 font-mono"
                    title={c.chargedMicro ? `${creditsExact(c.chargedMicro)} 积分` : undefined}
                  >
                    {c.chargedMicro === null ? "—" : creditsAmount(c.chargedMicro)}
                  </td>
                  <td className="px-2 py-3">
                    {stateText(c)}
                    {c.wouldReject && (
                      <p className="mt-1 text-warning">本应拒绝:{REJECT_TEXT[c.wouldReject]}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={loading}
          onClick={() => void load(next)}
        >
          加载更早的运行
        </Button>
      )}
    </section>
  );
}
