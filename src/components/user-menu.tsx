"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { clearMe, initialsOf, isAdminView, useMe } from "@/lib/use-me";
import { Bot, ChevronsUpDown, LogIn, LogOut, Settings, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * 侧栏底部的用户菜单。
 *
 * 【为什么要有】改造前只有设置页显示了当前账号,也只有它有登出按钮 ——
 * 在工作台、构建器、用量页里,既看不到自己是谁,也没有任何退出的入口。
 * 用户菜单放在侧栏底部是各家产品的共识位置,同时它也是进入设置区的唯一入口 ——
 * 主区导航只剩会话,配置类的去处全在这里面。
 */
export function UserMenu() {
  const { me, loading } = useMe();
  const router = useRouter();

  async function logout() {
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } finally {
      // 【为什么放在 finally】请求失败也要清本地缓存并跳走。
      // 停在原地会让人以为还登录着,而 cookie 可能已经没了。
      clearMe();
      toast.success("已登出");
      router.replace("/login");
      router.refresh();
    }
  }

  if (loading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center gap-2 p-2">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="grid flex-1 gap-1 group-data-[collapsible=icon]:hidden">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const user = me?.user;

  // 要求登录却没登录:给一条明确的去路,而不是一个点不动的灰头像
  if (!user && me?.authRequired) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="去登录">
            <Link href="/login">
              <LogIn className="text-muted-foreground" />
              <span className="text-xs">去登录</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  /**
   * 本地模式(OWA_AUTH_REQUIRED=false)下没有真实账号。
   *
   * 【为什么不给登出】这时后端根本没有会话,给的是一个匿名 admin;
   * 点登出会跳到 /login,而 /login 又把你原样弹回来 —— 一个死循环按钮。
   */
  const identity = user
    ? { initials: initialsOf(user.email), name: user.email, role: user.role }
    : { initials: "本地", name: "本地模式", role: "未启用登录" };

  // 头像 + 两行文字,触发器和菜单头部是同一块东西,不重复写
  const identityBlock = (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg bg-brand/15 text-[11px] font-semibold text-brand">
          {identity.initials}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left leading-tight">
        <span className="truncate text-xs font-medium">{identity.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">{identity.role}</span>
      </div>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {identityBlock}
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            // 触发器在侧栏最底部,往上弹菜单才贴着它;往下没有空间,Radix 会把它翻上来但位置更飘
            side="top"
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5">
                {identityBlock}
                {user?.role === "admin" && (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    管理员
                  </Badge>
                )}
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            {/*
              这一组是【离开工作台能去的所有地方】,三个子空间一个不落。

              【为什么智能体也在这儿】它有工作台选择器旁边的齿轮做就近入口,
              但那个入口只在工作台上有 —— 人在设置区想去改智能体,得先返回
              工作台再找齿轮。子空间之间没有互通的路,就只能靠记"哪个从哪进"。
              头像菜单在三个空间的侧栏底部都在,把它当成统一的换区入口,
              记一个地方就够了。

              【那"智能体不是配置"还成立吗】成立 —— 这一组的语义是"去哪儿",
              不是"配置项"。所以智能体排在最前:它是这里唯一一个日常会去的地方,
              账号设置和平台管理都是出事才点开的。

              每项只给一个入口,不把设置区的三项摊开。摊开试过 —— 一个本来
              两三行的菜单被撑成两屏似的清单,反而要在里面找;进了设置区
              侧栏本来就把它们列着。
            */}
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/agents">
                  <Bot />
                  我的智能体
                </Link>
              </DropdownMenuItem>
              {/*
                落点必须和设置区侧栏的第一项一致,否则进去会看到一个
                和高亮项对不上的页面。
              */}
              <DropdownMenuItem asChild>
                <Link href="/settings/keys">
                  <Settings />
                  账号设置
                </Link>
              </DropdownMenuItem>
              {/*
                非 admin 完全看不到这一项。服务端还有一道 requireAdmin ——
                隐藏入口只是不摆在眼前,手敲地址一样要挡住。
              */}
              {isAdminView(me) && (
                <DropdownMenuItem asChild>
                  <Link href="/admin/accounts">
                    <ShieldCheck />
                    平台管理
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>

            {user && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
                  <LogOut />
                  登出
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
