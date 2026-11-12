"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentHref } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import {
  Activity,
  Braces,
  Copy,
  Eye,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Store,
  Terminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import {
  type BadgeKind,
  type StudioAgent,
  deleteBlock,
  formatUpdated,
  studioBadges,
  studioSource,
} from "./studio-model";

const BADGE_ICON: Partial<Record<BadgeKind, typeof Eye>> = {
  read: Eye,
  write: Pencil,
  market: Store,
  api: Braces,
};

export function AgentBadges({ agent }: { agent: StudioAgent }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {studioBadges(agent).map((b) => {
        const Icon = BADGE_ICON[b.kind];
        return (
          <Badge key={b.kind} variant={b.variant} title={b.title}>
            {Icon && <Icon aria-hidden="true" />}
            {b.label}
          </Badge>
        );
      })}
    </div>
  );
}

export const chatHref = (id: string) => `/chat?agent=${encodeURIComponent(id)}`;

async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success(`已复制 ID：${id}`);
  } catch {
    toast.error("复制失败，请手动选中 ID 复制");
  }
}

/** 更多菜单:复制 ID、新建会话、运行记录、接入、删除(不能删时说明原因) */
export function AgentMoreMenu({
  agent,
  onDeleteAction,
  className,
}: {
  agent: StudioAgent;
  onDeleteAction: (agent: StudioAgent) => void;
  className?: string;
}) {
  const block = deleteBlock(agent);
  const readOnly = agent.canWrite === false;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${agent.name} 的更多操作`}
          className={cn("relative z-10 text-muted-foreground max-md:size-11", className)}
        >
          <MoreHorizontal className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={() => void copyId(agent.id)}>
          <Copy />
          复制 ID
          <span className="ml-auto max-w-24 truncate font-mono text-xs text-muted-foreground">
            {agent.id}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={chatHref(agent.id)}>
            <MessageSquare />
            新建会话
          </Link>
        </DropdownMenuItem>
        {!readOnly && (
          <>
            <DropdownMenuItem asChild>
              <Link href={agentHref({ id: agent.id, stage: "runs" })}>
                <Activity />
                运行记录
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={agentHref({ id: agent.id, stage: "access" })}>
                <Terminal />
                接入
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {block ? (
          // 不用 disabled 的菜单项:它整体半透明,说明文字的对比度就不够了
          <div className="flex flex-wrap items-center gap-x-2 px-3 py-2 text-sm text-muted-foreground">
            <Trash2 className="size-4" aria-hidden="true" />
            删除
            <span className="w-full pl-6 text-xs">{block}</span>
          </div>
        ) : (
          <DropdownMenuItem variant="destructive" onSelect={() => onDeleteAction(agent)}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 卡片。整张可点(一个铺满的按钮负责「打开」),对话、打开、更多菜单叠在它上面。
 * 不把整张卡做成 <a>:里面还有别的按钮,嵌套交互元素不合法、读屏也会念成一大串。
 */
export function AgentCard({
  agent,
  onOpenAction,
  onDeleteAction,
}: {
  agent: StudioAgent;
  onOpenAction: (agent: StudioAgent) => void;
  onDeleteAction: (agent: StudioAgent) => void;
}) {
  return (
    <article className="group relative flex flex-col gap-2.5 rounded-[18px] border border-border bg-card px-5 pt-5 pb-4 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgba(60,50,30,0.08)] focus-within:shadow-[0_10px_30px_rgba(60,50,30,0.08)]">
      <button
        type="button"
        className="absolute inset-0 rounded-[18px] outline-none focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB]"
        aria-label={`打开 ${agent.name}`}
        onClick={() => onOpenAction(agent)}
      />
      <div className="flex items-start gap-3">
        <AgentAvatar id={agent.id} icon={agent.icon} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg leading-snug font-bold">{agent.name}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground">{agent.id}</p>
        </div>
        <AgentMoreMenu agent={agent} onDeleteAction={onDeleteAction} className="-mt-1 -mr-1" />
      </div>
      <p className="line-clamp-2 min-h-11 text-sm text-[#4A4740] max-md:text-base">
        {agent.description || <span className="text-muted-foreground">没有描述</span>}
      </p>
      <AgentBadges agent={agent} />
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft pt-3 text-[13px] text-muted-foreground">
        <span>
          近 7 天{" "}
          <b className="font-semibold text-foreground">{(agent.runs7d ?? 0).toLocaleString()}</b>{" "}
          次运行
        </span>
        <span>更新于 {formatUpdated(agent.updatedAt)}</span>
        <span className="relative z-10 ml-auto flex gap-1.5">
          <Button asChild variant="outline" size="sm" className="max-md:h-11">
            <Link href={chatHref(agent.id)}>
              <MessageSquare />
              对话
            </Link>
          </Button>
          <Button size="sm" className="max-md:h-11" onClick={() => onOpenAction(agent)}>
            打开
          </Button>
        </span>
      </div>
    </article>
  );
}

/** 列表视图 */
export function AgentTable({
  agents,
  onOpenAction,
  onDeleteAction,
}: {
  agents: StudioAgent[];
  onOpenAction: (agent: StudioAgent) => void;
  onDeleteAction: (agent: StudioAgent) => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">智能体</th>
            <th className="w-[38%] px-4 py-2.5 font-medium max-md:hidden">状态</th>
            <th className="w-28 px-4 py-2.5 font-medium max-lg:hidden">来源</th>
            <th className="w-28 px-4 py-2.5 text-right font-medium max-md:hidden">近 7 天运行</th>
            <th className="w-28 px-4 py-2.5 font-medium max-lg:hidden">更新时间</th>
            <th className="w-[140px] px-4 py-2.5 max-md:w-[112px]">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} className="border-b border-line-soft last:border-0 hover:bg-[#FAF9F6]">
              <td className="px-4 py-3">
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB]"
                  onClick={() => onOpenAction(a)}
                >
                  <AgentAvatar id={a.id} icon={a.icon} size={32} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{a.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {a.id}
                    </span>
                  </span>
                </button>
              </td>
              <td className="px-4 py-3 max-md:hidden">
                <AgentBadges agent={a} />
              </td>
              <td className="px-4 py-3 text-muted-foreground max-lg:hidden">{studioSource(a)}</td>
              <td className="px-4 py-3 text-right tabular-nums max-md:hidden">
                {(a.runs7d ?? 0).toLocaleString()}
              </td>
              <td className="px-4 py-3 text-muted-foreground max-lg:hidden">
                {formatUpdated(a.updatedAt)}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <Button asChild variant="ghost" size="sm" className="max-md:h-11">
                    <Link href={chatHref(a.id)}>对话</Link>
                  </Button>
                  <AgentMoreMenu agent={a} onDeleteAction={onDeleteAction} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
