"use client";

import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * 一块数据没读到时的统一样子:说清是哪块没读到、为什么,给一个重试。
 *
 * 【为什么要统一】改造前各页面各写各的 —— 有的只有一行红色 "HTTP 404",
 * 有的红字下面还同时挂着"载入中…",看不出是失败了还是还在等。
 * 失败就只显示失败,并且永远给出路。
 */
export function LoadError({
  what,
  message,
  onRetryAction,
  compact = false,
}: {
  /** 没读到的是什么,如「账号列表」 */
  what: string;
  message: string;
  onRetryAction?: () => void;
  /** 区块内的小号样式(不占满整块区域) */
  compact?: boolean;
}) {
  return (
    <output
      className={
        compact
          ? "flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
          : "flex flex-col items-start gap-2 p-4 text-xs"
      }
    >
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="size-3.5 shrink-0" />
        {what}没读到
      </p>
      <p className="min-w-0 flex-1 text-muted-foreground">{message}</p>
      {onRetryAction && (
        <Button variant="outline" size="xs" onClick={onRetryAction}>
          <RefreshCw />
          重试
        </Button>
      )}
    </output>
  );
}
