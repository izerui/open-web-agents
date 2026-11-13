"use client";

import { type SIDE_NAV, sideNavFor } from "@/lib/nav/routes";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type SideKind = keyof typeof SIDE_NAV;

/** 开发者 / 账户 / 平台管理三个空间的左侧栏;选中项是白底细边(原型 .side a.on)。本地模式不列积分与套餐、账号安全 */
export function SideNav({
  kind,
  onNavigateAction,
}: { kind: SideKind; onNavigateAction?: () => void }) {
  const pathname = usePathname();
  const { me } = useMe();
  return (
    <nav aria-label="本区页面" className="flex flex-col gap-0.5">
      {sideNavFor(kind, me).map((g, i) => (
        <div key={g.group} className={cn(i > 0 && "mt-2.5")}>
          <div className="px-3 py-1.5 text-xs text-muted-foreground">{g.group}</div>
          {g.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigateAction}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-2.5 rounded-xl border border-transparent px-3 text-sm text-[#3C3A35] hover:bg-accent",
                  active && "border-border bg-card font-semibold text-foreground hover:bg-card",
                )}
              >
                <item.icon className="size-[17px]" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
