"use client";

import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHead, EmptyState, tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import {
  CHARGE_SOURCE_LABEL,
  SESSION_SOURCE_TO_CHARGE,
} from "@/lib/modules/billing/domain/charge-summary";
import { creditsAmount, creditsExact } from "@/lib/modules/billing/domain/credits-display";
import type { RunChargeItem } from "@/lib/modules/billing/run-charge-ports";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { chargeStatus } from "./billing-display";
import type { ChargeDrill } from "./charge-summary";

const amount = (micro: string | null) =>
  micro === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span title={`${creditsExact(micro)} 积分`}>{creditsAmount(micro)}</span>
  );

/** 运行计费明细:每次运行按用量应扣与实际扣除 */
export function RunChargeList({
  accountId,
  drill,
  onClearDrill,
  showRunsLink = false,
}: {
  accountId?: string;
  /** 从消耗汇总点进来的筛选 */
  drill?: ChargeDrill | null;
  onClearDrill?: () => void;
  /** 个人页:底部给「去运行记录看输入和回答」 */
  showRunsLink?: boolean;
}) {
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
      for (const [k, v] of Object.entries(drill?.params ?? {})) params.set(k, v);
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
    [accountId, drill],
  );
  useEffect(() => {
    setItems([]);
    void load();
  }, [load]);

  return (
    <section
      className="mb-6 scroll-mt-4 rounded-2xl border border-border bg-card"
      aria-label="运行计费明细"
      id="run-charge-list"
    >
      <CardHead
        title="运行明细"
        meta={
          drill ? (
            <span
              className="inline-flex h-8 items-center gap-2 rounded-full bg-primary pr-1.5 pl-3 text-[13px] text-primary-foreground"
              data-testid="run-charge-drill"
            >
              只看：{drill.label}
              <button
                type="button"
                className="h-6 rounded-full bg-white/15 px-2.5 text-xs"
                onClick={onClearDrill}
              >
                看全部
              </button>
            </span>
          ) : (
            "点上方汇总的一行，只看那一项"
          )
        }
        actions={
          <>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {items.length} 条{next ? "，还有更早的" : ""}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              title="刷新运行消耗"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn("size-[15px]", loading && "animate-spin")} />
              刷新
            </Button>
          </>
        }
      />
      {error && (
        <div className="px-[22px] pb-4">
          <LoadError compact what="运行消耗" message={error} onRetryAction={() => void load()} />
        </div>
      )}
      {items.length === 0 ? (
        error ? null : loading ? (
          <p className="px-[22px] pb-5 text-sm text-muted-foreground">载入中…</p>
        ) : (
          <EmptyState title="这段时间里没有明细" />
        )
      ) : (
        <div className={tb.wrap}>
          <table className={cn(tb.table, "min-w-[960px]")}>
            <caption className="sr-only">运行计费明细</caption>
            <thead>
              <tr>
                <th scope="col" className={cn(tb.th, tb.first)}>
                  时间
                </th>
                <th scope="col" className={tb.th}>
                  智能体
                </th>
                <th scope="col" className={tb.th}>
                  来源
                </th>
                <th scope="col" className={tb.th}>
                  API Key
                </th>
                <th scope="col" className={cn(tb.th, tb.right)}>
                  应扣
                </th>
                <th scope="col" className={cn(tb.th, tb.right)}>
                  实际扣除
                </th>
                <th scope="col" className={cn(tb.th, tb.right)}>
                  冻结
                </th>
                <th scope="col" className={cn(tb.th, tb.last)}>
                  状态
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const st = chargeStatus(c);
                return (
                  <tr key={c.runId} data-testid="run-charge">
                    <td className={cn(tb.td, tb.first, tb.num)}>
                      <span title={formatTime(c.createdAt)}>{shortTime(c.createdAt)}</span>
                    </td>
                    <td className={cn(tb.td, "min-w-40 max-w-xs break-words")}>
                      {c.agentName ?? "已删除的智能体"}
                      <div className="break-all font-mono text-xs text-muted-foreground">
                        {c.runId}
                      </div>
                    </td>
                    <td className={cn(tb.td, "whitespace-nowrap")}>
                      {c.source ? (
                        CHARGE_SOURCE_LABEL[SESSION_SOURCE_TO_CHARGE[c.source] ?? "other"]
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={cn(tb.td, "min-w-32 max-w-56 break-words")}>
                      {c.apiKeyId ? (
                        <>
                          {c.apiKeyName ?? "已吊销的 Key"}
                          <div className="font-mono text-xs text-muted-foreground">
                            {c.apiKeyHint ?? `ID ${c.apiKeyId.slice(0, 12)}`}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">不经 Key</span>
                      )}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(c.estimatedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(c.chargedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                      {amount(c.reservedMicro)}
                    </td>
                    <td className={cn(tb.td, tb.last, "min-w-44")}>
                      <Badge variant={st.tone}>{st.label}</Badge>
                      {st.note && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{st.note}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(next || showRunsLink) && (
        <div className="flex flex-wrap items-center justify-center gap-4 p-3.5">
          {next && (
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(next)}>
              加载更早的运行
            </Button>
          )}
          {showRunsLink && (
            <Link
              className="text-xs underline decoration-[#C9C4B8] underline-offset-[3px]"
              href="/developer/runs"
            >
              去运行记录看每次运行的输入和回答
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
