"use client";

import { AppShell } from "@/components/shell/app-shell";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { PanelLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AgentTree } from "./agent-tree";
import { type AgentObject, AgentWorkspaceHeader } from "./agent-workspace-header";

export type ToolWindow = {
  title: React.ReactNode;
  actions?: React.ReactNode;
  body: React.ReactNode;
  width?: number;
};

/**
 * 对话页、智能体设计器的过渡外壳:AppShell(全幅)+ 左侧工具窗口 + 对象头。
 * 阶段 3(对话)与阶段 5(构建页)按原型重做后删除。
 */
export function IdeFrame({
  context,
  widgets,
  onSearchAction,
  toolWindow,
  object,
  status,
  children,
}: {
  context?: React.ReactNode;
  widgets?: React.ReactNode;
  onSearchAction?: () => void;
  toolWindow?: ToolWindow;
  object?: AgentObject;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [treeOpen, setTreeOpen] = useState(false);
  const tree = (
    <>
      <div className="flex min-h-14 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {toolWindow?.title ?? "智能体"}
        </h2>
        {toolWindow?.actions ?? (
          <Link
            href="/agents/new"
            aria-label="新建智能体"
            title="新建智能体"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
          >
            <Plus className="size-[18px]" />
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {toolWindow?.body ?? (
          <AgentTree
            activeAgentId={object?.id}
            activeSessionId={object?.sessionId}
            tab={object?.tab}
          />
        )}
      </div>
    </>
  );
  return (
    <AppShell fullBleed onSearchAction={onSearchAction}>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[268px] shrink-0 flex-col border-r border-border max-md:hidden">
          {tree}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 窄屏收起左栏;智能体与会话从这里打开 */}
          <button
            type="button"
            aria-label="打开智能体树"
            onClick={() => setTreeOpen(true)}
            className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-sm text-muted-foreground md:hidden"
          >
            <PanelLeft className="size-[18px]" />
            智能体与会话
          </button>
          {object ? (
            <AgentWorkspaceHeader object={object} actions={widgets} />
          ) : context ? (
            <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-6 py-3 max-md:px-3">
              <div className="min-w-0 flex-1">{context}</div>
              {widgets}
            </div>
          ) : null}
          {children}
          {status && (
            <div className="shrink-0 border-t border-border px-4 py-1 text-xs text-muted-foreground">
              {status}
            </div>
          )}
        </div>
      </div>
      <Sheet open={treeOpen} onOpenChange={setTreeOpen}>
        <SheetContent side="left" className="w-[86vw] max-w-80 gap-0 px-0 pt-8 pb-0">
          <SheetTitle className="sr-only">智能体与会话</SheetTitle>
          <SheetDescription className="sr-only">选择智能体或历史会话</SheetDescription>
          {/* 子项的键盘操作由原生链接处理,此处只负责选择后关闭抽屉 */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: links provide keyboard activation */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a,[data-close-drawer]")) setTreeOpen(false);
            }}
          >
            {tree}
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
