"use client";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { isAdminView, useMe } from "@/lib/use-me";
import { useRouter } from "next/navigation";
import { requestClientNavigation } from "./client-navigation";
import { ADMIN_NAV, BILLING_NAV, type NavItem, PERSONAL_NAV, WORKSPACE_NAV } from "./nav";

export function NavigationCommands({ onSelectedAction }: { onSelectedAction: () => void }) {
  const router = useRouter();
  const { me } = useMe();
  const groups: { heading: string; items: readonly NavItem[] }[] = [
    { heading: "工作区", items: WORKSPACE_NAV },
    { heading: "用量与费用", items: BILLING_NAV },
    { heading: "账号设置", items: PERSONAL_NAV },
    ...(isAdminView(me) ? [{ heading: "平台管理", items: ADMIN_NAV }] : []),
  ];
  return groups.map((group, index) => (
    <div key={group.heading}>
      {index > 0 && <CommandSeparator />}
      <CommandGroup heading={group.heading}>
        {group.items.map((item) => (
          <CommandItem
            key={item.href}
            value={`${group.heading} ${item.label} ${item.href}`}
            onSelect={() => {
              if (!requestClientNavigation(item.href)) return;
              onSelectedAction();
              router.push(item.href);
            }}
          >
            <item.icon />
            <span>{item.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </div>
  ));
}

/**
 * 工作台以外页面的 ⌘K:只负责跳转。
 *
 * 【为什么不复用工作台的命令面板】那一个要会话列表和智能体列表,
 * 在设置页里专门去拉这两份数据只为了一个跳转面板,不划算;
 * 工作台自己有带会话搜索的完整版本。
 *
 * 【为什么这里能列管理页】它读得到当前用户的角色,非管理员看不到这一组 ——
 * 不会出现"搜得到却用不了"的结果。
 */
export function NavPalette({
  open,
  onOpenChangeAction,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChangeAction}
      title="跳转"
      description="搜索页面并跳转"
    >
      <CommandInput placeholder="搜索页面…" />
      <CommandList>
        <CommandEmpty>没有匹配的页面</CommandEmpty>
        <NavigationCommands onSelectedAction={() => onOpenChangeAction(false)} />
      </CommandList>
    </CommandDialog>
  );
}
