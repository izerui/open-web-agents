"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronRight, Info, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Spin } from "./chat-bits";
import { groupPickerAgents, pickerNote } from "./chat-view.logic";
import type { AgentSummary } from "./types";

/**
 * 新会话:先选智能体。每一项说明这次跑的是草稿还是已发布 vN
 * (规则与 POST /api/sessions 一致:能编辑的人跑草稿,其他人跑已发布版本,从未发布一律跑草稿)。
 */
export function NewSessionDialog({
  open,
  onOpenChangeAction,
  agents,
  agentsState,
  onRetryAction,
  meId,
  runningTitle,
  onPickAction,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
  agents: AgentSummary[];
  agentsState: "loading" | "ok" | "error";
  onRetryAction: () => void;
  meId: string | null;
  /** 还在运行的会话名:新会话不会打断它 */
  runningTitle: string | null;
  onPickAction: (agentId: string) => void;
}) {
  const groups = useMemo(() => groupPickerAgents(agents, meId), [agents, meId]);
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of agents) seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    return seen;
  }, [agents]);

  return (
    <Dialog open={open} onOpenChange={onOpenChangeAction}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新会话</DialogTitle>
          <DialogDescription>
            选一个智能体开始。你有编辑权限的智能体跑草稿，其他的跑已发布版本。
          </DialogDescription>
        </DialogHeader>
        {runningTitle && (
          <p className="flex items-center gap-2 rounded-[10px] bg-warning-soft px-3 py-2 text-sm text-warning-text">
            <Info className="size-[15px] shrink-0" />「{runningTitle}」还在运行，新会话不会打断它。
          </p>
        )}
        <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
          {agentsState === "loading" ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Spin />
              正在读取智能体…
            </p>
          ) : agentsState === "error" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <TriangleAlert className="mx-auto size-6 text-destructive" />
              <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">
                智能体列表没读到
              </p>
              <Button variant="outline" size="sm" className="mt-2" onClick={onRetryAction}>
                <RefreshCw />
                重试
              </Button>
            </div>
          ) : agents.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p className="mb-1 font-display text-[17px] text-foreground">还没有可用的智能体</p>
              <p>先创建一个智能体，或请管理员分享给你。</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.group} aria-label={g.group}>
                <h3 className="px-3 pt-2.5 pb-0.5 text-xs font-normal text-muted-foreground">
                  {g.group}
                </h3>
                <ul className="flex flex-col gap-1">
                  {g.agents.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => onPickAction(a.id)}
                        className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left hover:border-border hover:bg-[#F6F5F1]"
                      >
                        <AgentAvatar id={a.id} icon={a.icon} size={36} className="shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">
                            {a.name}
                            {(dupNames.get(a.name) ?? 0) > 1 && (
                              <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                                {a.id.slice(0, 6)}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-[13px] text-muted-foreground">
                            {pickerNote(a, g.group)}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <Link
            href="/"
            className="text-sm underline decoration-[#C9C4B8] underline-offset-[3px]"
            onClick={() => onOpenChangeAction(false)}
          >
            去探索找更多智能体
          </Link>
          <Button variant="outline" onClick={() => onOpenChangeAction(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
