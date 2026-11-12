"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { ModelPrice } from "@/features/models/model-price";
import { cn } from "@/lib/utils";
import { Activity, FolderOpen, PanelLeft } from "lucide-react";
import Link from "next/link";
import { Spin } from "./chat-bits";
import { type BadgeTone, agentPageHref } from "./chat-view.logic";
import type { AgentSummary } from "./types";

export type RightTab = "files" | "runs";

const TONE: Record<BadgeTone, string> = {
  warning: "bg-warning-soft text-warning-text",
  success: "bg-success-soft text-success-text",
  outline: "border border-border text-muted-foreground",
};

/**
 * 对话头:眼睛头像、会话名、智能体名(自己的去构建页,其他去市场详情)、版本徽标、模型与单价、
 * 「工作区文件」「执行详情」两个开关。窄屏左侧多一个打开会话列表的按钮。
 */
export function ChatHeader({
  title,
  agent,
  badge,
  model,
  rightTab,
  onToggleAction,
  onOpenListAction,
}: {
  title: string;
  agent?: AgentSummary;
  /** 没有可用智能体(链接失效)时不显示 */
  badge?: { label: string; tone: BadgeTone; title: string };
  model?: string;
  rightTab: RightTab | null;
  onToggleAction: (tab: RightTab) => void;
  onOpenListAction: () => void;
}) {
  const href = agent ? agentPageHref(agent) : undefined;
  const toggle = (tab: RightTab, label: string, Icon: typeof FolderOpen) => (
    <button
      type="button"
      aria-pressed={rightTab === tab}
      aria-label={label}
      onClick={() => onToggleAction(tab)}
      className={cn(
        "inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] whitespace-nowrap text-[#3C3A35] hover:bg-[#F4F2EC] max-md:size-11 max-md:justify-center max-md:px-0",
        rightTab === tab && "border-primary bg-primary text-primary-foreground hover:bg-black",
      )}
    >
      <Icon className="size-[15px]" />
      <span className="max-md:hidden">{label}</span>
    </button>
  );
  return (
    <section
      aria-label="当前对话"
      className="flex min-h-[66px] shrink-0 items-center gap-3 border-b border-line-soft px-[18px] py-3 max-md:gap-2 max-md:px-2"
    >
      <button
        type="button"
        aria-label="会话列表"
        onClick={onOpenListAction}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent md:hidden"
      >
        <PanelLeft className="size-5" />
      </button>
      {agent && href && (
        <Link href={href} tabIndex={-1} aria-hidden className="shrink-0 rounded-full">
          <AgentAvatar id={agent.id} icon={agent.icon} size={36} />
        </Link>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15.5px] leading-[1.35] font-semibold">{title}</h1>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground max-md:flex-nowrap max-md:overflow-hidden">
          {agent && href && (
            <Link
              href={href}
              title={agent.canWrite ? "打开构建页" : "查看智能体详情"}
              className="truncate font-medium text-foreground hover:underline hover:underline-offset-[3px]"
            >
              {agent.name}
            </Link>
          )}
          {badge && (
            <span
              title={badge.title}
              className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs whitespace-nowrap",
                TONE[badge.tone],
              )}
            >
              {badge.label === "运行中" && <Spin className="size-[11px] border-[1.5px]" />}
              {badge.label}
            </span>
          )}
          <ModelPrice model={model} className="whitespace-nowrap max-md:hidden" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-md:gap-0.5">
        {toggle("files", "工作区文件", FolderOpen)}
        {toggle("runs", "执行详情", Activity)}
      </div>
    </section>
  );
}
