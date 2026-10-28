"use client";

import { NavigationCommands } from "@/components/ide/nav-palette";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Bot, MessageSquare, Plus } from "lucide-react";
import { useEffect } from "react";
import { activityOf, relativeTime, sessionLabel } from "./session-groups";
import type { AgentSummary, SessionSummary } from "./types";

/**
 * Cmd/Ctrl+K 命令面板:会话搜索、切换智能体、跳页面。
 *
 * 【为什么需要】会话在侧栏是一个只能滚动的列表,攒到几十条之后就只能靠肉眼找。
 * 这里让标题可搜。
 */
export function CommandPalette({
  open,
  onOpenChangeAction,
  sessions,
  agents,
  currentAgentId,
  running,
  onOpenSessionAction,
  onNewSessionAction,
  onPickAgentAction,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
  sessions: SessionSummary[];
  agents: AgentSummary[];
  currentAgentId: string;
  running: boolean;
  onOpenSessionAction: (id: string) => void;
  onNewSessionAction: () => void;
  onPickAgentAction: (id: string) => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChangeAction(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChangeAction]);

  /** 选中即关闭 —— 面板是过路的,不该在动作之后还挡着结果。 */
  const run = (fn: () => void) => {
    fn();
    onOpenChangeAction(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChangeAction}
      title="命令面板"
      description="搜索会话、切换智能体或跳转页面"
    >
      <CommandInput placeholder="搜索会话,或输入命令…" />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>

        <CommandGroup heading="操作">
          <CommandItem
            value="新建会话 new session"
            disabled={running}
            onSelect={() => run(onNewSessionAction)}
          >
            <Plus />
            <span>新会话</span>
          </CommandItem>
        </CommandGroup>

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="会话">
              {sessions.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`${s.title ?? ""} ${s.id}`}
                  onSelect={() => run(() => onOpenSessionAction(s.id))}
                >
                  <MessageSquare />
                  <span className="flex-1 truncate">{sessionLabel(s)}</span>
                  {/* 标题可能整批重复,id 是唯一能区分的东西,别只留时间 */}
                  <CommandShortcut>
                    {relativeTime(activityOf(s))}
                    {s.runCount ? <span className="ml-1.5">{s.runCount} 轮</span> : null}
                    <span className="ml-1.5 font-mono opacity-60">{s.id.slice(0, 6)}</span>
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* 运行中切智能体会把当前这轮丢掉,不给这个入口 */}
        {!running && agents.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="切换智能体(会开一个新会话)">
              {agents.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`智能体 ${a.name} ${a.id}`}
                  onSelect={() => run(() => onPickAgentAction(a.id))}
                >
                  {/* 智能体不能跟"前往构建器"共用扳手图标,一列看下来分不清哪行是什么 */}
                  <Bot className={cn(a.id === currentAgentId && "text-brand")} />
                  <span className="flex-1 truncate">{a.name}</span>
                  {/* 同名智能体(克隆来的、批量建的)只有 id 能分清 */}
                  {agents.some((b) => b.id !== a.id && b.name === a.name) && (
                    <CommandShortcut className="font-mono">{a.id.slice(0, 6)}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <NavigationCommands onSelectedAction={() => onOpenChangeAction(false)} />
      </CommandList>
    </CommandDialog>
  );
}
