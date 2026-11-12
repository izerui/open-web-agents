"use client";

import { Badge } from "@/components/ui/badge";
import { tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import { creditsExact } from "@/lib/modules/billing/domain/credits-display";
import type { LedgerEntry } from "@/lib/modules/billing/ports";
import { cn } from "@/lib/utils";
import { ledgerKind } from "./billing-display";

/** 积分账户流水表(个人「积分与套餐」与管理员「计费」共用) */
export function LedgerTable({
  items,
  compact = false,
}: {
  items: LedgerEntry[];
  /** 概览里的「最近流水」:不显示冻结余额与流水号 */
  compact?: boolean;
}) {
  return (
    <div className={tb.wrap}>
      <table className={cn(tb.table, "min-w-[680px]")}>
        <caption className="sr-only">积分账户流水</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(tb.th, tb.first)}>
              时间
            </th>
            <th scope="col" className={tb.th}>
              类型
            </th>
            <th scope="col" className={cn(tb.th, tb.right)}>
              积分
            </th>
            <th scope="col" className={cn(tb.th, tb.right)}>
              可用余额
            </th>
            <th scope="col" className={cn(tb.th, tb.last)}>
              说明
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((entry) => {
            const k = ledgerKind(entry);
            return (
              <tr key={entry.id}>
                <td className={cn(tb.td, tb.first, tb.num)}>
                  <span title={new Date(entry.createdAt).toLocaleString()}>
                    {shortTime(entry.createdAt)}
                  </span>
                </td>
                <td className={tb.td}>
                  <Badge variant={k.tone}>{k.label}</Badge>
                </td>
                <td
                  className={cn(
                    tb.td,
                    tb.num,
                    tb.right,
                    "font-mono",
                    k.sign === "+" && "text-success-text",
                  )}
                >
                  {k.sign}
                  {creditsExact(entry.amountMicroCredits)}
                </td>
                <td className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                  {creditsExact(entry.availableAfter)}
                  {!compact && (
                    <div className="text-xs text-muted-foreground">
                      冻结 {creditsExact(entry.reservedAfter)}
                    </div>
                  )}
                </td>
                <td className={cn(tb.td, tb.last, "min-w-48 break-words")}>
                  {entry.reason || entry.reference}
                  {!compact && (
                    <div className="break-all text-xs text-muted-foreground">{entry.id}</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
