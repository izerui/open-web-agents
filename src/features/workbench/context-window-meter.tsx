"use client";

import { Button } from "@/components/ui/button";
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
  const isUnknown = usedPercentage === null;
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = isUnknown ? 0 : circumference * (1 - normalizedPercentage / 100);
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--destructive)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-muted-foreground"
          aria-label={
            percentageStr
              ? `上下文窗口已用 ${percentageStr}`
              : `上下文 ${formatContextWindowTokens(usedTokens)} tokens`
          }
        >
          <span className="relative flex size-5 items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="absolute inset-0 size-full -rotate-90 transform-gpu"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                strokeWidth="3"
              />
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke={usageColor}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={isUnknown ? "2 3" : circumference}
                strokeDashoffset={dashOffset}
                className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
              />
            </svg>
            <span className="absolute text-[7px] font-medium leading-none text-muted-foreground">
              {formatContextWindowTokens(usedTokens)}
            </span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-56 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-muted-foreground">上下文窗口</div>
            {maxTokens !== null && percentageStr ? (
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {percentageStr} · {formatContextWindowTokens(usedTokens)}/
                {formatContextWindowTokens(maxTokens)}
              </div>
            ) : (
              <div className="text-[11px] tabular-nums text-muted-foreground">
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
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
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
