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
import { agentStatusText, sessionMeta, sessionTitle } from "./palette-logic";

type AgentLite = {
  id: string;
  name: string;
  icon?: string | null;
  publishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
  /** false = 只有市场使用权,不是「我的」智能体 */
  canRead?: boolean;
};
type SessionLite = {
  id: string;
  title?: string | null;
  agentId: string;
  createdAt?: number;
  runCount?: number;
};

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
      .then((d) => alive && setAgents((d.agents ?? []).filter((a) => a.canRead !== false)))
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
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {agentStatusText(a)}
                  </span>
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
                  value={`会话 ${sessionTitle(s)} ${agentName(s.agentId)} ${s.id}`}
                  onSelect={() => go(`/chat?session=${encodeURIComponent(s.id)}`)}
                >
                  <AgentAvatar id={s.agentId} size={20} />
                  <span className="truncate">{sessionTitle(s)}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {sessionMeta(s)}
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
