"use client";

import { requestClientNavigation } from "@/components/ide/client-navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { meMenuItems } from "@/lib/nav/routes";
import { clearMe, initialsOf, isAdminView, useMe } from "@/lib/use-me";
import { Coins, Lock, LogIn, LogOut, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";

const ICONS: Record<string, typeof Coins> = {
  积分与套餐: Coins,
  账号安全: Lock,
  操作日志: ScrollText,
  平台管理: ShieldCheck,
};

/** 顶栏右端的头像菜单:我是谁、积分、账号安全、操作日志、登出(菜单项由 meMenuItems 决定) */
export function MeMenu() {
  const { me, loading } = useMe();
  const router = useRouter();
  const loggingOutRef = useRef(false);

  async function logout() {
    if (loggingOutRef.current || !requestClientNavigation("/login", true)) return;
    loggingOutRef.current = true;
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
    }
  }

  if (loading) return <Skeleton className="size-[34px] rounded-full" />;

  const items = meMenuItems(me);
  if (items.length === 1 && items[0]?.href === "/login") {
    return (
      <Link
        href="/login"
        className="flex h-[34px] items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <LogIn className="size-4" />
        去登录
      </Link>
    );
  }

  const local = me?.authRequired === false && !me.user;
  const email = me?.user?.email ?? (local ? "本地模式" : "账号信息未读取到");
  const name = me?.user ? (email.split("@")[0] ?? email) : email;
  const role = local ? "本地模式" : isAdminView(me) ? "管理员" : me?.user ? "普通账号" : "—";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="账号菜单"
        className="flex items-center gap-2 rounded-full py-0.5 pr-0.5 pl-2.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB] max-md:size-11 max-md:justify-center max-md:p-0"
      >
        <span className="max-w-32 truncate max-md:hidden">{name}</span>
        <span className="flex size-[34px] items-center justify-center rounded-full bg-[#D9D1C1] text-sm font-semibold text-[#3B362D]">
          {me?.user ? initialsOf(email) : local ? "本" : "?"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate font-semibold text-foreground">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{email}</div>
          <span className="mt-1.5 inline-flex h-[22px] items-center rounded-full bg-muted px-2 text-xs text-[#4D4A43]">
            {role}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => {
          if (item.action === "logout") {
            return (
              <div key={item.label}>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void logout()}>
                  <LogOut />
                  {item.label}
                </DropdownMenuItem>
              </div>
            );
          }
          const Icon = ICONS[item.label] ?? Coins;
          return (
            <DropdownMenuItem key={item.label} asChild>
              <Link href={item.href ?? "/"}>
                <Icon />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
