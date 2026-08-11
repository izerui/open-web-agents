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
import { ChevronsUpDown, LogIn, LogOut, Settings, ShieldCheck } from "lucide-react";
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

            <DropdownMenuGroup>
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
