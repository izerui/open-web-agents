"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { requestClientNavigation } from "@/lib/client-navigation";
import { fetchJson } from "@/lib/fetch-json";
import { agentHref } from "@/lib/nav/routes";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NavigationCommands } from "./nav-commands";

type AgentLite = { id: string; name: string; icon?: string | null };
type SessionLite = { id: string; title?: string | null; agentId: string };

/**
 * 全站 ⌘K:页面、我的智能体、最近会话。
 * 智能体和会话在面板打开时才拉 —— 大多数页面一整天都不会按 ⌘K,没必要每次换页都请求。
 */
export function CommandPalette({
  open,
  onOpenChangeAction,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
}) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [sessions, setSessions] = useState<SessionLite[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchJson<{ agents?: AgentLite[] }>("/api/agents")
      .then((d) => alive && setAgents(d.agents ?? []))
      .catch(() => alive && setAgents([]));
    void fetchJson<{ sessions?: SessionLite[] }>("/api/sessions")
      .then((d) => alive && setSessions((d.sessions ?? []).slice(0, 8)))
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, [open]);

  const go = (href: string) => {
    if (!requestClientNavigation(href)) return;
    onOpenChangeAction(false);
    router.push(href);
  };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChangeAction}
      title="搜索"
      description="搜索页面、智能体与会话"
    >
      <CommandInput placeholder="搜索页面、智能体、会话…" />
      <CommandList>
        <CommandEmpty>没有匹配的页面、智能体或会话</CommandEmpty>
        <NavigationCommands onSelectedAction={() => onOpenChangeAction(false)} />
        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="智能体">
              {agents.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`智能体 ${a.name} ${a.id}`}
                  onSelect={() => go(agentHref({ id: a.id }))}
                >
                  <AgentAvatar id={a.id} icon={a.icon} size={20} />
                  <span className="truncate">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="最近会话">
              {sessions.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`会话 ${s.title ?? s.id} ${agentName(s.agentId)}`}
                  onSelect={() => go(`/chat?session=${encodeURIComponent(s.id)}`)}
                >
                  <AgentAvatar id={s.agentId} size={20} />
                  <span className="truncate">{s.title || s.id.slice(0, 8)}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {agentName(s.agentId)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
