"use client";

import type { AgentObject } from "@/components/ide/agent-workspace-header";
import { IdeFrame } from "@/components/ide/ide-frame";
import { ADMIN_NAV, BILLING_NAV, PERSONAL_NAV } from "@/components/ide/nav";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

export { ADMIN_NAV, PERSONAL_NAV } from "@/components/ide/nav";
export type SpaceArea = "agents" | "personal" | "admin" | "market";

export function SpaceShell({
  title,
  subtitle,
  actions,
  children,
  width = "wide",
  sidebarExtra,
  area = "personal",
  object,
  footer,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: "narrow" | "wide" | "full" | "flush";
  sidebarExtra?: React.ReactNode;
  area?: SpaceArea;
  object?: AgentObject;
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();
  const billing = BILLING_NAV.some((item) => item.href === pathname);
  const account = PERSONAL_NAV.some((item) => item.href === pathname);
  const items = object
    ? []
    : area === "admin"
      ? ADMIN_NAV
      : billing
        ? BILLING_NAV
        : account
          ? PERSONAL_NAV
          : [];
  const heading =
    object?.name ??
    (area === "admin" ? "平台管理" : billing ? "用量与费用" : account ? "账号设置" : title);
  return (
    <IdeFrame
      object={object}
      toolWindow={!object && sidebarExtra ? { title: "智能体", body: sidebarExtra } : undefined}
      context={<h1 className="text-lg font-semibold">{heading}</h1>}
    >
      {items.length > 0 && (
        <nav
          aria-label={`${heading}页面`}
          className="flex shrink-0 flex-wrap gap-1 border-b border-border bg-sidebar px-5 py-1"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                pathname === item.href || pathname.startsWith(`${item.href}/`) ? "page" : undefined
              }
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                (pathname === item.href || pathname.startsWith(`${item.href}/`)) &&
                  "bg-sidebar-active text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      {(subtitle || actions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          {subtitle && <p className="min-w-0 flex-1 text-sm text-muted-foreground">{subtitle}</p>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {width === "flush" ? (
        <div className="flex min-h-0 flex-1">{children}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className={cn(
              "mx-auto w-full space-y-6 px-8 py-7 max-md:px-4 max-md:py-5",
              width === "narrow" && "max-w-3xl",
              width === "wide" && "max-w-[1100px]",
            )}
          >
            {children}
          </div>
        </div>
      )}
      {footer && (
        <div className="shrink-0 border-t border-border bg-background px-8 py-3 max-md:px-4">
          {footer}
        </div>
      )}
    </IdeFrame>
  );
}
