"use client";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { navFor, spaceOf } from "@/lib/nav/routes";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CommandPalette } from "./command-palette";
import { type SideKind, SideNav } from "./side-nav";
import { TopNav } from "./top-nav";

/**
 * 全站外壳(coze-v3「对话搭建」):60px 顶栏 + 可选的 220px 左侧栏 + 主区。
 *
 * - side:开发者 / 账户 / 平台管理三个空间有自己的页面清单,放在左侧栏
 * - fullBleed:对话页、构建页自己管分栏和滚动,主区不加内边距也不滚动
 * - onSearchAction:页面有自己的命令面板(对话页)时由它接管 ⌘K 与搜索按钮
 * - 窄屏(<768px)顶栏的空间导航与左侧栏收进左侧抽屉
 */
export function AppShell({
  side,
  fullBleed = false,
  onSearchAction,
  children,
}: {
  side?: SideKind;
  fullBleed?: boolean;
  onSearchAction?: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { me } = useMe();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (onSearchAction) return;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onSearchAction]);

  const current = spaceOf(pathname);

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <a
        href="#main-content"
        className="sr-only z-50 focus:not-sr-only focus:absolute focus:rounded-full focus:bg-card focus:p-3"
      >
        跳到主要内容
      </a>
      <TopNav
        onSearchAction={onSearchAction ?? (() => setPaletteOpen(true))}
        onOpenMenuAction={() => setMenuOpen(true)}
      />
      {!onSearchAction && <CommandPalette open={paletteOpen} onOpenChangeAction={setPaletteOpen} />}
      <div className="flex min-h-0 flex-1">
        {side && (
          <aside className="w-[220px] shrink-0 overflow-y-auto border-r border-border px-3 py-[18px] max-md:hidden">
            <SideNav kind={side} />
          </aside>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col outline-none",
            !fullBleed && "overflow-y-auto",
          )}
        >
          {children}
        </main>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="left"
          className="w-[86vw] max-w-80 gap-0 overflow-y-auto px-3 pt-12 pb-6"
        >
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SheetDescription className="sr-only">切换空间与页面</SheetDescription>
          <nav aria-label="主导航" className="flex flex-col gap-0.5">
            {navFor(me).map((s) => (
              <Link
                key={s.key}
                href={s.href}
                onClick={() => setMenuOpen(false)}
                aria-current={current === s.key ? "page" : undefined}
                className={cn(
                  "flex h-11 items-center rounded-xl border border-transparent px-3 text-[15px] text-[#3C3A35] hover:bg-accent",
                  current === s.key && "border-border bg-background font-semibold text-foreground",
                )}
              >
                {s.label}
              </Link>
            ))}
          </nav>
          {side && (
            <div className="mt-4 border-t border-border pt-3">
              <SideNav kind={side} onNavigateAction={() => setMenuOpen(false)} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
