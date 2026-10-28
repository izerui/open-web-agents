"use client";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { UserMenu } from "@/components/user-menu";
import { isAdminView, useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Activity, PanelLeft, Plus, Search, ShieldCheck, Store, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AgentTree } from "./agent-tree";
import { type AgentObject, AgentWorkspaceHeader } from "./agent-workspace-header";
import { BrandMark } from "./brand-mark";
import { NavPalette } from "./nav-palette";

export type ToolWindow = {
  title: React.ReactNode;
  actions?: React.ReactNode;
  body: React.ReactNode;
  width?: number;
};

/** B 方案:品牌顶栏、对象树、对象内部工作区,不再叠加全局图标条。 */
export function IdeFrame({
  context,
  widgets,
  onSearchAction,
  toolWindow,
  object,
  status,
  children,
}: {
  context?: React.ReactNode;
  widgets?: React.ReactNode;
  onSearchAction?: () => void;
  toolWindow?: ToolWindow;
  object?: AgentObject;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { me } = useMe();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (onSearchAction) return;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onSearchAction]);

  const globals = [
    {
      href: "/settings/runs",
      label: "全部运行",
      icon: Activity,
      active: !object && pathname === "/settings/runs",
    },
    { href: "/market", label: "发现智能体", icon: Store, active: pathname.startsWith("/market") },
    {
      href: "/settings/billing",
      label: "用量与费用",
      icon: Wallet,
      active: [
        "/settings/billing",
        "/settings/usage",
        "/settings/packages",
        "/settings/credentials",
      ].includes(pathname),
    },
    ...(isAdminView(me)
      ? [
          {
            href: "/admin/accounts",
            label: "平台管理",
            icon: ShieldCheck,
            active: pathname.startsWith("/admin"),
          },
        ]
      : []),
  ];
  const tree = (
    <>
      <div className="mb-3 flex min-h-14 shrink-0 items-center gap-2 px-[18px]">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {toolWindow?.title ?? "智能体"}
        </h2>
        {toolWindow?.actions ?? (
          <Link
            href="/agents?new=1"
            aria-label="新建智能体"
            title="新建智能体"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Plus className="size-[18px]" />
          </Link>
        )}
      </div>
      <div className="scrollbar-fade min-h-0 flex-1 overflow-y-auto">
        {toolWindow?.body ?? (
          <AgentTree
            activeAgentId={object?.id}
            activeSessionId={object?.sessionId}
            tab={object?.tab}
          />
        )}
      </div>
      <nav aria-label="全局功能" className="mx-2 shrink-0 border-t border-border pt-2">
        {globals.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
              item.active && "bg-sidebar-active text-foreground",
            )}
            onClick={() => setMobileOpen(false)}
          >
            <item.icon className="size-[18px]" />
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mx-2 mt-2 border-t border-border px-1 py-3">
        <UserMenu expanded />
      </div>
    </>
  );

  return (
    <div className="object-frame flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      {!onSearchAction && <NavPalette open={paletteOpen} onOpenChangeAction={setPaletteOpen} />}
      <a
        href="#workspace-content"
        className="sr-only z-50 focus:not-sr-only focus:absolute focus:bg-popover focus:p-3"
      >
        跳到工作区
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 max-md:gap-2 max-md:px-2">
        <button
          type="button"
          aria-label="打开智能体树"
          className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent md:hidden"
          onClick={() => setMobileOpen(true)}
        >
          <PanelLeft className="size-[18px]" />
        </button>
        <Link
          href="/"
          className="flex min-w-0 items-center gap-3"
          aria-label="Open Web Agents 工作台"
        >
          <BrandMark className="size-8 text-xs" />
          <span className="truncate text-sm font-semibold">Open Web Agents</span>
        </Link>
        <span className="flex-1" />
        <button
          type="button"
          title="搜索页面与会话"
          aria-label="搜索页面与会话"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onSearchAction ?? (() => setPaletteOpen(true))}
        >
          <Search className="size-[18px]" />
        </button>
      </header>
      <div className="ide-layout flex min-h-0 flex-1">
        <aside className="hidden w-[264px] min-h-0 shrink-0 flex-col bg-sidebar md:flex">
          {tree}
        </aside>
        <main
          id="workspace-content"
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        >
          {object ? (
            <AgentWorkspaceHeader object={object} actions={widgets} />
          ) : context ? (
            <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-6 py-3 max-md:px-3">
              <div className="min-w-0 flex-1">{context}</div>
              {widgets}
            </div>
          ) : null}
          {children}
          {status && (
            <div className="shrink-0 border-t border-border px-4 py-1 text-xs text-muted-foreground">
              {status}
            </div>
          )}
        </main>
      </div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[86vw] max-w-80 gap-0 bg-sidebar px-0 pt-8 pb-0">
          <SheetTitle className="sr-only">智能体与会话</SheetTitle>
          <SheetDescription className="sr-only">选择智能体、历史会话或全局功能</SheetDescription>
          {/* 子项的键盘操作由原生链接处理,此处只负责选择后关闭抽屉。 */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: links provide keyboard activation */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a,[data-close-drawer]")) setMobileOpen(false);
            }}
          >
            {tree}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
