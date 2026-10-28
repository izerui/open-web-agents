import { cn } from "@/lib/utils";

/**
 * 产品徽标。主工具栏和登录页共用一个 —— 曾经登录页写的是 "A"、工具栏写的是 "O",
 * 第一眼和第二眼看到的不是同一个牌子。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded bg-primary font-mono text-[10px] font-bold tracking-tight text-primary-foreground",
        className,
      )}
    >
      OW
    </span>
  );
}
