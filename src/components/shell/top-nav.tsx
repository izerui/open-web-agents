"use client";

import { Kbd } from "@/components/ui/kbd";
import { navFor, spaceOf } from "@/lib/nav/routes";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Coins, Menu, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./brand-mark";
import { MeMenu } from "./me-menu";
import { useBalance } from "./use-balance";

const PILL =
  "flex h-[34px] items-center gap-2 rounded-full border border-border bg-card px-3.5 text-[13px] text-foreground hover:border-[#C9C4B8]";

/** 全站顶栏:品牌、一级空间、搜索(⌘K)、积分、头像菜单 */
export function TopNav({
  onSearchAction,
  onOpenMenuAction,
}: {
  onSearchAction: () => void;
  onOpenMenuAction: () => void;
}) {
  const pathname = usePathname();
  const { me } = useMe();
  const current = spaceOf(pathname);
  // 关闭登录的本地模式接口返回 authenticated:false,但后端按匿名 admin 放行,积分照样能读
  const balance = useBalance(Boolean(me?.authenticated || me?.authRequired === false));

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-7 border-b border-border bg-background px-7 max-md:gap-2 max-md:px-3">
      <button
        type="button"
        aria-label="打开导航"
        onClick={onOpenMenuAction}
        className="flex size-11 items-center justify-center rounded-full hover:bg-accent md:hidden"
      >
        <Menu className="size-5" />
      </button>
      <Link href="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold">
        <BrandMark />
        <span className="max-sm:hidden">Open Web Agents</span>
      </Link>
      <nav aria-label="主导航" className="ml-6 flex gap-1 max-md:hidden">
        {navFor(me).map((s) => (
          <Link
            key={s.key}
            href={s.href}
            aria-current={current === s.key ? "page" : undefined}
            className={cn(
              "flex h-9 items-center rounded-full px-3.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
              current === s.key && "bg-[#E9E7E0] font-semibold text-foreground hover:bg-[#E9E7E0]",
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3 max-md:gap-1.5">
        <button
          type="button"
          onClick={onSearchAction}
          aria-label="搜索页面、智能体与会话"
          className={cn(
            PILL,
            "max-md:size-11 max-md:justify-center max-md:border-0 max-md:bg-transparent max-md:p-0",
          )}
        >
          <Search className="size-4" />
          <span className="text-muted-foreground max-md:hidden">搜索</span>
          <Kbd className="max-md:hidden">⌘K</Kbd>
        </button>
        {balance.status === "ok" && (
          <Link href="/account/billing" className={cn(PILL, "max-sm:hidden")} title="积分与套餐">
            <Coins className="size-4" />
            <b className="font-semibold">{balance.available}</b>
            <span className="text-muted-foreground">积分</span>
          </Link>
        )}
        <MeMenu balance={balance} />
      </div>
    </header>
  );
}
