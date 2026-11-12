"use client";

import type { AgentObject } from "@/components/ide/agent-workspace-header";
import { IdeFrame } from "@/components/ide/ide-frame";
import { AppShell } from "@/components/shell/app-shell";
import type { SideKind } from "@/components/shell/side-nav";
import { spaceOf } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";

export type SpaceArea = "agents" | "personal" | "admin" | "market";

/**
 * 普通页面的外壳:AppShell + 页头(衬线标题、说明、操作)+ 内容宽度。
 *
 * 左侧栏由当前地址所在的空间决定(开发者 / 账户 / 平台管理),不再靠调用方传 area ——
 * 同一个视图(如运行记录)在个人和平台两处复用时,侧栏自然跟着地址走。
 * 阶段 2–7 逐页按原型重做时,页面会直接用 AppShell,这个包装随之删除。
 */
export function SpaceShell({
  title,
  subtitle,
  actions,
  children,
  width = "wide",
  sidebarExtra,
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
  const space = spaceOf(pathname);
  const side: SideKind | undefined =
    space === "developer" || space === "account" || space === "admin" ? space : undefined;

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
          {object && subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          {!object && (
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-[30px] leading-tight font-bold">{title}</h1>
                {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
              </div>
              {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
          )}
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

  // 智能体对象页、带智能体列表的工作室页:沿用左侧智能体树(宽屏常驻,窄屏从抽屉打开)
  if (object || sidebarExtra) {
    return (
      <IdeFrame
        object={object}
        widgets={object ? actions : undefined}
        toolWindow={sidebarExtra ? { title: "我的智能体", body: sidebarExtra } : undefined}
      >
        {main}
      </IdeFrame>
    );
  }

  return (
    <AppShell side={side} fullBleed>
      {main}
    </AppShell>
  );
}
