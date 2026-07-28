"use client";

import { NavLink } from "@/components/nav-link";
import { Separator } from "@/components/ui/separator";

function AppHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        <nav className="flex items-center gap-3">
          <NavLink href="/">工作台</NavLink>
          <NavLink href="/builder">构建器</NavLink>
          <NavLink href="/groups">组</NavLink>
          <NavLink href="/usage">用量</NavLink>
          <NavLink href="/settings">设置</NavLink>
        </nav>
        {actions && (
          <>
            <Separator orientation="vertical" className="h-4" />
            {actions}
          </>
        )}
      </div>
    </header>
  );
}

export { AppHeader };
