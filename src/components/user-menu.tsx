"use client";

import { requestClientNavigation } from "@/components/ide/client-navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { clearMe, initialsOf, useMe } from "@/lib/use-me";
import { LogIn, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 主工具栏右端的头像菜单。
 *
 * 【为什么要有】改造前只有设置页显示了当前账号,也只有它有登出按钮 ——
 * 在工作台、构建器、用量页里,既看不到自己是谁,也没有任何退出的入口。
 *
 * 【为什么不再列各个去处】去处都常驻在左侧工具窗口条上了。这里只回答
 * "我是谁、怎么退出",外加两个设置入口 —— 头像旁边找设置是各家产品的共识。
 */
export function UserMenu({ expanded = false }: { expanded?: boolean }) {
  const { me, loading } = useMe();
  const router = useRouter();
  const loggingOutRef = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    if (loggingOutRef.current || !requestClientNavigation("/login", true)) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    try {
      await fetchJson("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      clearMe();
      toast.success("已登出");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      toast.error(`登出失败:${errorText(error)}`);
    } finally {
      loggingOutRef.current = false;
      setLoggingOut(false);
    }
  }

  if (loading) return <Skeleton className="size-6 rounded-full" />;

  const user = me?.user;

  if (!user && me?.authRequired) {
    return (
      <Link
        href="/login"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <LogIn className="size-3.5" />
        去登录
      </Link>
    );
  }

  const identity = user
    ? { initials: initialsOf(user.email), name: user.email, role: user.role }
    : { initials: "本地", name: "本地模式", role: "未启用登录" };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${identity.name} 的账号菜单`}
          className={
            expanded
              ? "flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              : "flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
          }
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-sidebar-active text-[10px] font-semibold text-foreground">
            {identity.initials}
          </span>
          {expanded && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{identity.name}</span>
              <span className="block text-xs text-muted-foreground">账号设置</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="min-w-56" align="end" sideOffset={6}>
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm text-foreground">{identity.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {user ? (user.role === "admin" ? "管理员" : "普通账号") : identity.role}
          </p>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          {/* 落点和设置树的第一项一致,否则进去看到的页面和高亮项对不上 */}
          <DropdownMenuItem asChild>
            <Link href="/settings/account">
              <Settings />
              账号设置
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {user && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={loggingOut}
              onSelect={() => void logout()}
            >
              <LogOut />
              登出
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
