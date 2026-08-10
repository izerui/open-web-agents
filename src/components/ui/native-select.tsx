import { cn } from "@/lib/utils";
import { type SelectHTMLAttributes, forwardRef } from "react";

/**
 * 箭头必须自己画。
 *
 * 原生 select 默认 `appearance: auto`,外观交给系统绘制 —— 我们的 Tailwind 背景色
 * 会被直接忽略,深色页面上呈现为白底黑字。`color-scheme: dark` 只在系统真的有
 * 暗色主题时才救得回来,靠不住(无头浏览器、部分 Linux 桌面下就是白的)。
 * 所以这里关掉系统外观、自己铺一个 chevron 背景图,任何环境下表现一致。
 */
const CHEVRON = `data:image/svg+xml;utf8,${encodeURIComponent(
    // 颜色写原始 '#',交给 encodeURIComponent 去编码 —— 这里先写成 '%23' 会被二次编码成 '%2523'
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9299a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
)}`;

const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, style, ...props }, ref) => {
    return (
      <select
        className={cn(
          "flex h-9 w-full appearance-none items-center rounded-md border border-input bg-background bg-no-repeat py-1 pl-3 pr-8 text-sm text-foreground shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // 展开后的选项列表也归我们管,否则又是一整块白
          "[&>option]:bg-popover [&>option]:text-popover-foreground",
          className,
        )}
        ref={ref}
        style={{
          backgroundImage: `url("${CHEVRON}")`,
          backgroundPosition: "right 0.5rem center",
          backgroundSize: "1rem",
          ...style,
        }}
        {...props}
      >
        {children}
      </select>
    );
  },
);
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
