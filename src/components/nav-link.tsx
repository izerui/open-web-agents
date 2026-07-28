"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "text-xs transition-colors hover:text-foreground",
        active ? "text-foreground font-medium" : "text-muted-foreground",
      )}
    >
      {children}
    </Link>
  );
}

export { NavLink };
