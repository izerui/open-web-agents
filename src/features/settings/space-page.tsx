"use client";

import { AppShell } from "@/components/shell/app-shell";
import type { SideKind } from "@/components/shell/side-nav";
import { cn } from "@/lib/utils";

/**
 * 开发者 / 账户空间的页面框架(原型 .main + .ph):左侧栏 + 衬线大标题 + 说明 + 右侧操作。
 *
 * 直接用 AppShell,不经过 SpaceShell —— SpaceShell 只是阶段 1 的过渡包装,
 * 管理页(阶段 7)和构建页(阶段 5)换完后会删掉。
 */
export function SpacePage({
  side,
  title,
  subtitle,
  actions,
  width = "wide",
  children,
}: {
  side: SideKind;
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** narrow:单个表单页(账号安全) */
  width?: "wide" | "narrow";
  children: React.ReactNode;
}) {
  return (
    <AppShell side={side}>
      <div
        className={cn(
          "mx-auto w-full px-[34px] pt-7 pb-12 max-md:px-4 max-md:pt-5",
          width === "wide" ? "max-w-[1240px]" : "max-w-3xl",
        )}
      >
        <header className="mb-[18px] flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-72">
            <h1 className="font-display text-[30px] leading-tight font-bold max-md:text-[26px]">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1.5 text-sm text-muted-foreground max-md:text-[15px]">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </AppShell>
  );
}

/** 原型 .banner:页内说明条 */
export function Banner({
  tone = "info",
  icon,
  children,
  className,
}: {
  tone?: "info" | "warn" | "ok";
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-3 rounded-[14px] px-4 py-3 text-sm leading-relaxed",
        tone === "info" && "bg-[#F2F1EC] text-[#3C3A35]",
        tone === "warn" && "bg-warning-soft text-warning-text",
        tone === "ok" && "bg-success-soft text-success-text",
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0 [&>svg]:size-[18px]">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 原型 .stat:统计卡 */
export function StatCard({
  label,
  value,
  hint,
  children,
  testId,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card px-[18px] py-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        className="mt-1 mb-0.5 break-all font-display text-[26px] leading-tight font-semibold"
      >
        {value}
      </dd>
      {children}
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** 原型卡片标题行(.dk-sech / .ab-sech) */
export function CardHead({
  title,
  meta,
  actions,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-[22px] pt-[18px] pb-3 max-md:px-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 原型 .empty-state */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="mb-1.5 font-display text-xl font-semibold">{title}</p>
      {children && <p className="mb-4 text-sm text-muted-foreground">{children}</p>}
      {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** 原型 table.tb 的单元格样式;横向放不下时在卡片内滚动,页面本身不横向溢出 */
export const tb = {
  wrap: "overflow-x-auto",
  table: "w-full border-collapse text-sm",
  th: "border-b border-border px-3 py-[9px] text-left text-[12.5px] font-medium whitespace-nowrap text-muted-foreground",
  td: "border-b border-line-soft px-3 py-[11px] align-middle",
  first: "pl-[22px] max-md:pl-4",
  last: "pr-[22px] max-md:pr-4",
  num: "tabular-nums whitespace-nowrap",
  right: "text-right",
  clickRow:
    "cursor-pointer hover:[&>td]:bg-[#FAF9F6] focus-visible:outline-none focus-visible:[&>td]:bg-[#FAF9F6]",
  selRow: "[&>td]:bg-[#F4F2EC]",
} as const;
