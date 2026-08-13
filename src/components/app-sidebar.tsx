"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";
import { Bot, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 主区导航 = 企业日常要干的两件事。
 *
 * 【为什么是这两项】一个账号就是一家企业,它在这个平台上的日常只有两件事:
 * 造自己的智能体,以及用它。剩下的(接入、用量、凭证)都是低频配置,
 * 收进设置区从底部头像进入。
 *
 * 【为什么智能体不放在设置里】它是企业的核心创作物,不是一项配置。
 * 之前把它塞进设置区的二级页,等于把这个产品最重要的功能
 * 藏进了"设置"——那是个人们只在出问题时才会点开的地方。
 */
const NAV_ITEMS = [
  { href: "/", label: "工作台", icon: LayoutDashboard },
  { href: "/agents", label: "我的智能体", icon: Bot },
] as const;

/**
 * 全站统一的侧边导航。
 *
 * 【为什么要统一】工作台原本是一套可折叠侧栏,其余页面是右上角一排小灰字 ——
 * 从工作台点进构建器,导航整个换了个样子,像是两个产品拼在一起。
 *
 * `headerExtra` 与 `children` 是给工作台留的口子:它在品牌下面还要放智能体选择器,
 * 在导航下面还要挂会话列表。其余页面两个都不传,侧栏就只剩导航。
 */
export function AppSidebar({
  headerExtra,
  children,
}: {
  headerExtra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2 border-b border-sidebar-border">
        <Link href="/" className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-primary-foreground">
            A
          </span>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Open Web Agents
          </span>
        </Link>
        {headerExtra}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>导航</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
              // 工作台是根路径,用 startsWith 会把所有页面都点亮
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={item.label}
                    className="relative data-[active=true]:bg-sidebar-active data-[active=true]:text-sidebar-active-foreground"
                  >
                    <Link href={item.href}>
                      <span
                        className={cn(
                          "absolute left-0 top-1.5 bottom-1.5 w-0.5 origin-left rounded-r-full bg-brand transition-transform duration-200",
                          active ? "scale-x-100" : "scale-x-0",
                        )}
                      />
                      <item.icon
                        className={cn(active ? "text-brand" : "text-muted-foreground/60")}
                      />
                      <span className="text-xs">{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {children}
      </SidebarContent>

      {/*
        用户菜单固定在底部。
        【为什么不放在 SidebarContent 里】工作台的会话列表挂在 children 上,
        会话一多就把它顶出可视区 —— 而"我是谁 / 怎么退出"是任何时候都得够得着的东西。
      */}
      <SidebarFooter className="border-t border-sidebar-border">
        <UserMenu />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
