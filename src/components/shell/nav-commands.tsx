"use client";

import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";
import { requestClientNavigation } from "@/lib/client-navigation";
import { type PaletteEntry, paletteEntries } from "@/lib/nav/routes";
import { useMe } from "@/lib/use-me";
import { CornerDownLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

/**
 * ⌘K 里的「页面」部分。页面清单来自 paletteEntries(按角色过滤),
 * 全站外壳的面板和对话页自己的命令面板共用这一份,不会一边多一边少。
 */
export function NavigationCommands({ onSelectedAction }: { onSelectedAction: () => void }) {
  const router = useRouter();
  const { me } = useMe();
  const pathname = usePathname();
  // 对话页自己的命令面板已有「新会话」(直接打开选智能体的弹层),这里不再重复一条跳转
  const onChat = pathname === "/chat";
  const groups = new Map<string, PaletteEntry[]>();
  for (const e of paletteEntries(me)) {
    if (onChat && e.href.startsWith("/chat?new=")) continue;
    groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  }
  return [...groups].map(([heading, items], index) => (
    <div key={heading}>
      {index > 0 && <CommandSeparator />}
      <CommandGroup heading={heading}>
        {items.map((item) => (
          <CommandItem
            key={item.href}
            value={`${heading} ${item.label} ${item.keywords} ${item.href}`}
            onSelect={() => {
              if (!requestClientNavigation(item.href)) return;
              onSelectedAction();
              router.push(item.href);
            }}
          >
            <CornerDownLeft className="text-muted-foreground" />
            <span>{item.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </div>
  ));
}
