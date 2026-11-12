"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter({
  usedTokens,
  maxTokens,
  totalProcessed,
}: {
  usedTokens: number;
  maxTokens: number | null;
  totalProcessed?: number | null;
}) {
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  const percentageStr = formatPercentage(usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentage ?? 0));
  const isOverloaded = normalizedPercentage > 90;
  const ringColor =
    normalizedPercentage > 80 ? "#B4442F" : normalizedPercentage > 60 ? "#B7791F" : "#3F7A57";
  const usageColor = isOverloaded
    ? "var(--destructive)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/*
          环旁边写上百分比。只有一个细环时,它和"加载中"的转圈长得一模一样,
          人会以为输入框还没准备好。
        */}
        <button
          type="button"
          className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-1.5 text-[12.5px] whitespace-nowrap text-muted-foreground hover:bg-[#F1EFE9] max-md:h-11"
          aria-label={`上下文已用 ${percentageStr ?? formatContextWindowTokens(usedTokens)}${
            totalProcessed ? `，累计 ${formatContextWindowTokens(totalProcessed)} token` : ""
          }`}
          title="上下文用量：上限按 200k 计"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
            <circle cx="10" cy="10" r="8" fill="none" stroke="#E2DFD7" strokeWidth="3" />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke={ringColor}
              strokeWidth="3"
              strokeDasharray={`${Math.max(1.5, (normalizedPercentage / 100) * 50.3)} 60`}
              transform="rotate(-90 10 10)"
              className="transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
            />
          </svg>
          <span className="max-md:hidden">
            上下文 {percentageStr ?? "0%"}
            {totalProcessed ? `，累计 ${formatContextWindowTokens(totalProcessed)} token` : ""}
          </span>
          <span className="md:hidden">{percentageStr ?? "0%"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-muted-foreground">
              {maxTokens !== null ? "上下文窗口" : "当前处理量"}
            </div>
            {maxTokens !== null && percentageStr ? (
              <div className="text-xs tabular-nums text-muted-foreground">
                {percentageStr} · {formatContextWindowTokens(usedTokens)}/
                {formatContextWindowTokens(maxTokens)}
              </div>
            ) : (
              <div className="text-xs tabular-nums text-muted-foreground">
                {formatContextWindowTokens(usedTokens)}
              </div>
            )}
          </div>
          {maxTokens !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{
                  width: `${normalizedPercentage}%`,
                  backgroundColor: usageColor,
                }}
              />
            </div>
          )}
          {totalProcessed != null && totalProcessed > 0 && (
            <div className="flex items-center justify-between gap-3 text-xs leading-4">
              <span className="text-muted-foreground">累计处理</span>
              <span className="font-medium tabular-nums text-muted-foreground">
                {formatContextWindowTokens(totalProcessed)}
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
