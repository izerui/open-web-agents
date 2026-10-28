"use client";

import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * 工具窗口里的分组:灰色小标题,可折叠。
 *
 * 【为什么不用 shadcn 的 SidebarGroup】那一套依赖 SidebarProvider 的上下文,
 * 只能活在它的 Sidebar 里;工具窗口是外壳自己画的,要一套不挑容器的列表。
 */
export function ToolGroup({
  label,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  label: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 w-full items-center gap-1 px-2 text-left text-sm font-medium text-foreground hover:bg-accent/60"
        >
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          {label}
        </button>
      ) : (
        <div className="flex h-7 items-center px-3 text-xs text-muted-foreground">{label}</div>
      )}
      {open && <ul>{children}</ul>}
    </div>
  );
}

/**
 * 工具窗口里的一行:28px 高、整行选中。
 *
 * `actions` 是行尾的操作(如会话的"…"菜单),鼠标移上或获得焦点才显现 ——
 * 一列几十行,每行都摆着操作按钮会把标题挤得看不清。
 */
export function ToolRow({
  active,
  icon,
  meta,
  actions,
  href,
  onClickAction,
  title,
  indent = 0,
  className,
  children,
}: {
  active?: boolean;
  icon?: React.ReactNode;
  /** 行尾的灰色附注(时间、计数),操作出现时让位 */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  href?: string;
  onClickAction?: () => void;
  title?: string;
  /** 缩进层级(设置树的子项是 1) */
  indent?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const inner = (
    <>
      {icon && (
        <span
          className={cn(
            "flex shrink-0 [&_svg]:size-4",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && (
        <span
          className={cn(
            "shrink-0 text-xs text-muted-foreground",
            actions && "group-hover/row:hidden group-focus-within/row:hidden",
          )}
        >
          {meta}
        </span>
      )}
    </>
  );
  const rowClass = cn(
    "flex h-7 min-w-0 flex-1 items-center gap-2 pr-2 text-left text-sm outline-none focus-visible:bg-accent",
    actions && "pr-8",
  );
  const style = { paddingLeft: 12 + indent * 16 };

  return (
    <li
      className={cn(
        "group/row relative flex items-center",
        active ? "bg-sidebar-active text-sidebar-active-foreground" : "hover:bg-accent",
        className,
      )}
    >
      {href ? (
        <Link
          href={href}
          title={title}
          aria-current={active ? "page" : undefined}
          className={rowClass}
          style={style}
        >
          {inner}
        </Link>
      ) : (
        <button
          type="button"
          title={title}
          aria-current={active ? "true" : undefined}
          onClick={onClickAction}
          className={rowClass}
          style={style}
        >
          {inner}
        </button>
      )}
      {actions && (
        <span className="absolute right-1 flex opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100">
          {actions}
        </span>
      )}
    </li>
  );
}
