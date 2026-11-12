"use client";

import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { hrefWithTab, tabFrom } from "./tab-param";

/*
 * 平台管理六页共用的骨架与小部件(原型 prototype/admin-*.html 与 assets/owa.css)。
 * 只用设计令牌对应的 Tailwind 类,不新增令牌。
 */

/** 页面:AppShell 管理侧栏 + 衬线大标题 + 说明 + 右侧操作 + 页签 */
export function AdminPage({
  title,
  subtitle,
  actions,
  tabs,
  back,
  children,
}: {
  /** 标题上方的返回链接(详情页) */
  back?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell side="admin">
      <div className="mx-auto w-full max-w-[1280px] px-[34px] pt-7 pb-12 max-md:px-4 max-md:pt-5">
        {back && <div className="mb-4">{back}</div>}
        <header className="mb-[18px] flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-80">
            <h1 className="font-display text-[30px] leading-tight font-bold">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {tabs}
        {children}
      </div>
    </AppShell>
  );
}

/** 页签与地址 ?tab= 同步:刷新、书签、旧地址重定向都落在对的页签 */
export function useTabParam<T extends string>(allowed: readonly T[], fallback: T) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tab = tabFrom(params.get("tab"), allowed, fallback);
  const setTab = useCallback(
    (next: T) => router.replace(hrefWithTab(pathname, params.toString(), next, fallback)),
    [router, pathname, params, fallback],
  );
  return [tab, setTab] as const;
}

export type TabItem<T extends string> = { value: T; label: string; badge?: ReactNode };

/** 线型页签(原型 .tabs):下划线标出当前页 */
export function AdminTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="mb-3 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border"
    >
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            aria-current={on ? "page" : undefined}
            onClick={() => onChange(t.value)}
            className={cn(
              "-mb-px flex h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:bg-accent",
              on && "border-foreground font-semibold text-foreground",
            )}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </nav>
  );
}

/** 灰底胶囊分段(原型 .seg):同一列表的筛选 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "inline-flex max-w-full min-w-0 overflow-x-auto rounded-full bg-secondary p-[3px] [scrollbar-width:none]",
        className,
      )}
    >
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(it.value)}
            className={cn(
              "h-[30px] shrink-0 rounded-full px-3.5 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:h-9",
              on && "bg-card font-semibold text-foreground shadow-xs",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 表格外框:白卡片,窄屏时表格在卡片内部横向滚动(页面本身不溢出) */
export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-2xl border border-border bg-card", className)}
    >
      {/* relative:表格里的 sr-only(绝对定位)以滚动容器为包含块,不会撑出页面横向滚动 */}
      <div className="relative overflow-x-auto">{children}</div>
    </div>
  );
}

/** 表格单元样式(原型 .tb):表头 12px 次要色,单元 11px/12px 内边距、浅分割线 */
export const TH =
  "px-3 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
export const TD = "border-t border-line-soft px-3 py-[11px] align-middle";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="font-display text-xl font-bold">{title}</p>
      {children && (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{children}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** 数字卡(原型 .stat) */
export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("min-w-0 rounded-2xl border border-border bg-card px-[18px] py-4", className)}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-display text-[26px] font-bold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * 右侧详情抽屉(原型 .drawer):顶栏下方贴右,不遮住左侧列表 —— 选另一行时抽屉内容直接切换。
 * Esc 关闭;打开时把焦点移进抽屉。
 */
export function AdminDrawer({
  label,
  head,
  onClose,
  children,
  testId,
}: {
  testId?: string;
  label: string;
  head: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      className="fixed top-[60px] right-0 bottom-0 z-30 flex w-[440px] max-w-full flex-col border-l border-border bg-card shadow-[-20px_0_50px_rgb(40_35_25/8%)] outline-none"
    >
      <div className="flex items-center gap-3 border-b border-line-soft px-[22px] py-[18px]">
        <div className="min-w-0 flex-1">{head}</div>
        <Button variant="ghost" size="icon" aria-label="关闭详情" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-[22px] py-[18px]">{children}</div>
    </aside>
  );
}

/** 抽屉里的一段(原型 .dsec) */
export function DrawerSection({
  title,
  desc,
  children,
  tone,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  tone?: "danger";
}) {
  return (
    <section className="rounded-[14px] border border-border px-4 py-3.5">
      <h3 className={cn("text-sm font-semibold", tone === "danger" && "text-destructive")}>
        {title}
      </h3>
      {desc && <p className="mt-1 mb-2 text-xs leading-relaxed text-muted-foreground">{desc}</p>}
      {children}
    </section>
  );
}

/** 圆形首字母头像(原型 .aa-face) */
export function Initial({ text, size = 28 }: { text: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size > 30 ? 16 : 12 }}
      className="grid shrink-0 place-items-center rounded-full bg-[#E6DFD1] font-semibold text-[#3B362D]"
    >
      {text.slice(0, 1).toUpperCase()}
    </span>
  );
}
