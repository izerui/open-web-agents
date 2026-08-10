"use client";

import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * 除工作台外所有页面的外壳:统一的侧栏 + 吸顶页头 + 居中内容区。
 *
 * 工作台不用这个 —— 它是三栏可拖拽的全屏布局,内容区不能被限宽和滚动容器包住。
 * 但两者共用同一个 AppSidebar,导航的观感和行为是一致的。
 */
export function AppShell({
  title,
  subtitle,
  actions,
  children,
  className,
  sidebarExtra,
  /** 表单类页面用窄栏更好读;数据密集的页面(如用量)用宽栏。 */
  width = "wide",
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  width?: "narrow" | "wide";
  /** 挂在统一导航下面的页面级条目列表(如构建器的助手列表),避免再开第二条侧栏。 */
  sidebarExtra?: React.ReactNode;
}) {
  return (
    <SidebarProvider className="h-screen min-h-0">
      <AppSidebar>{sidebarExtra}</AppSidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        {/* 吸顶页头:长表单往下滚时,标题和操作按钮不该跟着滚走 */}
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-tight">{title}</h1>
            {subtitle && (
              <p className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <div className={cn("min-h-0 flex-1 overflow-auto", className)}>
          <div
            className={cn("mx-auto space-y-6 p-6", width === "narrow" ? "max-w-3xl" : "max-w-4xl")}
          >
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
