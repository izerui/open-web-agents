"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { Store } from "lucide-react";
import Link from "next/link";

/**
 * 工作台的侧栏。
 *
 * 工作台保持会话为主,只增加一个前往市场的入口。此前品牌下面挂着一组"工作台 / 我的智能体"的
 * 平级导航项 —— 点一下,侧栏下半屏整个换掉,但顶部的智能体选择器还留在原地,
 * 而两个导航项和下面的会话条目又长得一模一样。人分不清刚才是换了页面
 * 还是换了智能体。
 *
 * 现在工作台是主场,侧栏只装它自己的东西:选什么智能体、开新会话、
 * 我干过的活。要去别的地方(智能体维护、账号设置、平台管理)都是"下钻进一个
 * 房间再走出来",由 SpaceShell 承担,不占主场的位置。
 *
 * 【为什么还留着两个插槽】`headerExtra` 放智能体选择器和新会话按钮,
 * `children` 放会话列表 —— 都由 workbench.tsx 传进来,因为它们要读工作台
 * 自己的状态(当前智能体、运行中与否、会话列表)。这个组件只负责骨架。
 */
export function WorkbenchSidebar({
  headerExtra,
  children,
}: {
  headerExtra?: React.ReactNode;
  children?: React.ReactNode;
}) {
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="智能体市场">
              <Link href="/market">
                <Store />
                <span>智能体市场</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="scrollbar-fade">{children}</SidebarContent>

      {/*
        用户菜单固定在底部。
        【为什么不放在 SidebarContent 里】会话列表挂在 children 上,
        会话一多就把它顶出可视区 —— 而"我是谁 / 怎么退出"是任何时候都得够得着的东西。
      */}
      <SidebarFooter className="border-t border-sidebar-border">
        <UserMenu />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
