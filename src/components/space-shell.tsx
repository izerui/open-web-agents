"use client";

import { AppShell } from "@/components/shell/app-shell";
import type { SideKind } from "@/components/shell/side-nav";
import { spaceOf } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";

export type SpaceArea = "agents" | "personal" | "admin" | "market";

const EmbeddedContext = createContext(false);

/**
 * 嵌入模式:外层页面已经有外壳与标题(如平台管理 /admin/ops 的三个页签分别装着
 * UsageView / RunsView / AuditView),里面视图自带的 SpaceShell 只保留说明与操作条,
 * 不再套一层 AppShell、不再出大标题。共享视图本身不用为此改代码。
 */
export function SpaceShellEmbed({ children }: { children: React.ReactNode }) {
  return <EmbeddedContext.Provider value>{children}</EmbeddedContext.Provider>;
}

/**
 * 共享视图(用量、审计、运行、计费)自带的页面外壳:AppShell + 页头(衬线标题、说明、操作)+ 内容宽度。
 * 这些视图在个人页与平台管理页里复用;平台管理用 SpaceShellEmbed 嵌进页签时只留说明与操作条。
 * 左侧栏由当前地址所在的空间决定(开发者 / 账户 / 平台管理)。新页面直接用 AppShell。
 */
export function SpaceShell({
  title,
  subtitle,
  actions,
  children,
  width = "wide",
  footer,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: "narrow" | "wide" | "full" | "flush";
  area?: SpaceArea;
  footer?: React.ReactNode;
}) {
  const pathname = usePathname();
  const embedded = useContext(EmbeddedContext);
  const space = spaceOf(pathname);
  const side: SideKind | undefined =
    space === "developer" || space === "account" || space === "admin" ? space : undefined;

  if (embedded) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {(subtitle || actions) && (
          <div className="flex flex-wrap items-center gap-3">
            {subtitle && <p className="min-w-0 flex-1 text-sm text-muted-foreground">{subtitle}</p>}
            {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
        {footer}
      </div>
    );
  }

  const body =
    width === "flush" ? (
      <div className="flex min-h-0 flex-1">{children}</div>
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto w-full space-y-6 px-[34px] pt-7 pb-10 max-md:px-4 max-md:py-5",
            width === "narrow" && "max-w-3xl",
            width === "wide" && "max-w-[1180px]",
          )}
        >
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[30px] leading-tight font-bold">{title}</h1>
              {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </div>
    );

  const main = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {body}
      {footer && (
        <div className="shrink-0 border-t border-border bg-background px-[34px] py-3 max-md:px-4">
          {footer}
        </div>
      )}
    </div>
  );

  return (
    <AppShell side={side} fullBleed>
      {main}
    </AppShell>
  );
}
