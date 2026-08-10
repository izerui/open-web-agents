"use client";

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
import { BarChart3, Bot, MessageSquare, Plus, Settings, Users, Wrench } from "lucide-react";
import { useEffect } from "react";
import { relativeTime } from "./session-groups";
import type { AssistantSummary, SessionSummary } from "./types";

const PAGES = [
  { href: "/builder", label: "构建器", icon: Wrench },
  { href: "/groups", label: "组", icon: Users },
  { href: "/usage", label: "用量", icon: BarChart3 },
  { href: "/settings", label: "设置", icon: Settings },
] as const;

/**
 * Cmd/Ctrl+K 命令面板:会话搜索、切换助手、跳页面。
 *
 * 【为什么需要】会话在侧栏是一个只能滚动的列表,攒到几十条之后就只能靠肉眼找。
 * 这里让标题可搜。
 */
export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  assistants,
  currentAssistantId,
  running,
  onOpenSession,
  onNewSession,
  onPickAssistant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  assistants: AssistantSummary[];
  currentAssistantId: string;
  running: boolean;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onPickAssistant: (id: string) => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  /** 选中即关闭 —— 面板是过路的,不该在动作之后还挡着结果。 */
  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="搜索会话、切换助手或跳转页面"
    >
      <CommandInput placeholder="搜索会话,或输入命令…" />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>

        <CommandGroup heading="操作">
          <CommandItem value="新建会话 new session" onSelect={() => run(onNewSession)}>
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
                  onSelect={() => run(() => onOpenSession(s.id))}
                >
                  <MessageSquare />
                  <span className="flex-1 truncate">{s.title || s.id.slice(0, 12)}</span>
                  {/* 标题可能整批重复,id 是唯一能区分的东西,别只留时间 */}
                  <CommandShortcut>
                    {relativeTime(s.createdAt)}
                    <span className="ml-1.5 font-mono opacity-60">{s.id.slice(0, 6)}</span>
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* 运行中切助手会把当前这轮丢掉,不给这个入口 */}
        {!running && assistants.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="切换助手(会开一个新会话)">
              {assistants.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`助手 ${a.name} ${a.id}`}
                  onSelect={() => run(() => onPickAssistant(a.id))}
                >
                  {/* 助手不能跟"前往构建器"共用扳手图标,一列看下来分不清哪行是什么 */}
                  <Bot className={cn(a.id === currentAssistantId && "text-brand")} />
                  <span className="flex-1 truncate">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="前往">
          {PAGES.map((p) => (
            <CommandItem
              key={p.href}
              value={`前往 ${p.label} ${p.href}`}
              onSelect={() => run(() => window.location.assign(p.href))}
            >
              <p.icon />
              <span>{p.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
