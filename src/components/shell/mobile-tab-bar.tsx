"use client";

import { MOBILE_TABS, type MobileTab, mobileTabOf, mobileTabsVisible } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { House, LayoutGrid, type LucideIcon, MessageSquare, User } from "lucide-react";
import Link from "next/link";

const ICONS: Record<MobileTab, LucideIcon> = {
  explore: House,
  chat: MessageSquare,
  studio: LayoutGrid,
  me: User,
};

/**
 * 手机底部标签栏(取舍 11,原型 mobile.html .mo-tb):探索 / 对话 / 工作室 / 我的。
 * 只在窄屏(<768px)显示;对话页、设计器会话页不显示(底部是输入框)。
 */
export function MobileTabBar({ pathname }: { pathname: string }) {
  if (!mobileTabsVisible(pathname)) return null;
  const current = mobileTabOf(pathname);
  return (
    <nav
      aria-label="底部导航"
      className="flex shrink-0 justify-around border-t border-border bg-card pt-1.5 pb-[max(env(safe-area-inset-bottom),6px)] md:hidden"
    >
      {MOBILE_TABS.map((t) => {
        const Icon = ICONS[t.key];
        const on = current === t.key;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex min-h-[50px] min-w-16 flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground",
              on && "font-semibold text-foreground",
            )}
          >
            <Icon className="size-[22px]" strokeWidth={on ? 2 : 1.6} aria-hidden="true" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
