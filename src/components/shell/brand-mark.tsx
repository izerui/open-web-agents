import { cn } from "@/lib/utils";

/**
 * 产品徽标:近黑圆形里两道白色竖眼,和智能体头像同一家族。
 * 顶栏和登录页共用这一个 —— 曾经两处各画各的,第一眼和第二眼看到的不是同一个牌子。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <circle cx="14" cy="14" r="13" fill="#1C1C1C" />
      <rect x="9" y="9" width="3.4" height="9" rx="1.7" fill="#fff" />
      <rect x="15.6" y="9" width="3.4" height="9" rx="1.7" fill="#fff" />
    </svg>
  );
}
