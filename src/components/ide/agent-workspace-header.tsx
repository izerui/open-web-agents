"use client";

import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Activity, Bot, MessageSquare, Plug, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export type AgentObject = {
  id: string;
  name: string;
  tab: "chat" | "config" | "runs" | "integration";
  sessionId?: string | null;
  canReadConfig?: boolean;
};

export function AgentWorkspaceHeader({
  object,
  actions,
}: {
  object: AgentObject;
  actions?: React.ReactNode;
}) {
  const { me } = useMe();
  const [remembered, setRemembered] = useState<{ agentId: string; sessionId: string | null }>();
  useEffect(() => {
    if (!me) return;
    const key = `owa.object-session:${me.user?.id ?? "local"}:${object.id}`;
    try {
      if (object.sessionId !== undefined) {
        if (object.sessionId) sessionStorage.setItem(key, object.sessionId);
        else sessionStorage.removeItem(key);
        setRemembered({ agentId: object.id, sessionId: object.sessionId });
      } else {
        setRemembered({ agentId: object.id, sessionId: sessionStorage.getItem(key) });
      }
    } catch {
      // 存储不可用时仍可通过树打开历史会话。
    }
  }, [me, object.id, object.sessionId]);
  const id = encodeURIComponent(object.id);
  const sessionId =
    object.sessionId !== undefined
      ? object.sessionId
      : remembered?.agentId === object.id
        ? remembered.sessionId
        : null;
  const chatHref = `/?agent=${id}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`;
  const items = [
    {
      key: "chat",
      label: "对话",
      icon: MessageSquare,
      href: chatHref,
    },
    { key: "config", label: "配置", icon: Settings2, href: `/agents?id=${id}` },
    { key: "runs", label: "运行", icon: Activity, href: `/settings/runs?agent=${id}` },
    { key: "integration", label: "接入", icon: Plug, href: `/settings/keys?agent=${id}` },
  ];
  return (
    <div className="shrink-0 bg-sidebar">
      <div className="flex min-h-[82px] items-center gap-3 px-6 pt-[18px] pb-3 max-md:min-h-0 max-md:px-3 max-md:py-3">
        <span className="flex size-[38px] shrink-0 items-center justify-center rounded-md bg-sidebar-active text-info">
          <Bot className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold max-md:text-base">{object.name}</h1>
          <p className="text-xs text-muted-foreground">智能体工作区</p>
        </div>
        {actions}
      </div>
      <nav
        aria-label="当前智能体工作区"
        className="flex gap-1.5 border-b border-border px-[22px] max-md:gap-0 max-md:px-1.5"
      >
        {items
          .filter((item) => item.key !== "config" || object.canReadConfig !== false)
          .map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={object.tab === item.key ? "page" : undefined}
              className={cn(
                "flex min-h-11 min-w-[88px] items-center justify-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-md:min-w-0 max-md:flex-1 max-md:px-2",
                object.tab === item.key && "border-info text-foreground",
              )}
            >
              <item.icon className="size-[18px]" />
              {item.label}
            </Link>
          ))}
      </nav>
    </div>
  );
}
