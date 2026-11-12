"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { AGENT_CATALOG_CHANGED, notifyAgentCatalogChanged } from "@/components/ide/agent-catalog";
import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { agentHref } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { LayoutGrid, List, Loader2, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentCard, AgentTable } from "./agent-card";
import { NewAgentDialog } from "./new-agent-dialog";
import { ReadonlyDrawer } from "./readonly-drawer";
import {
  type NewMode,
  type StudioAgent,
  type StudioTab,
  filterStudio,
  studioAgents,
  studioCounts,
} from "./studio-model";

const TABS: readonly [StudioTab, string][] = [
  ["mine", "我建的"],
  ["shared", "分享给我的"],
  ["all", "全部"],
];
const VIEW_KEY = "owa:studio-view";

function StateBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-[18px] border border-border bg-card px-6 py-14 text-center">
      {children}
    </div>
  );
}

function SkeletonCard() {
  const bar = "block rounded-lg bg-[#EFEDE7] motion-safe:animate-pulse";
  return (
    <div className="flex flex-col gap-2.5 rounded-[18px] border border-border bg-card px-5 pt-5 pb-4">
      <div className="flex items-center gap-3">
        <i className={cn(bar, "size-12 rounded-full")} />
        <div className="flex-1">
          <i className={cn(bar, "h-4 w-1/2")} />
          <i className={cn(bar, "mt-2 h-3 w-1/3")} />
        </div>
      </div>
      <i className={cn(bar, "h-3.5")} />
      <i className={cn(bar, "h-3.5 w-2/3")} />
      <i className={cn(bar, "h-[22px] w-1/2")} />
    </div>
  );
}

/**
 * 工作室 · 我的智能体(/agents)。
 * initialNew:从 /agents/new 进来时自动打开新建弹层(关闭后回到 /agents)。
 */
export function StudioView({
  initialNew = false,
  initialMode = "ai",
  initialDesc = "",
}: {
  initialNew?: boolean;
  initialMode?: NewMode;
  initialDesc?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [agents, setAgents] = useState<StudioAgent[] | null>(null);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [tab, setTab] = useState<StudioTab>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"card" | "list">("card");
  const [newOpen, setNewOpen] = useState(initialNew);
  const [readonly, setReadonly] = useState<StudioAgent | null>(null);
  const [deleting, setDeleting] = useState<StudioAgent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "list" || saved === "card") setView(saved);
  }, []);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 是显式的重新加载信号
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetchJson<{ agents?: StudioAgent[] }>("/api/agents", { signal: controller.signal })
      .then((d) => setAgents(studioAgents(d.agents ?? [])))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [reloadTick]);

  // 别处(⌘K、其他标签页里的构建页)建了或删了智能体时跟着刷新
  useEffect(() => {
    window.addEventListener(AGENT_CATALOG_CHANGED, reload);
    return () => window.removeEventListener(AGENT_CATALOG_CHANGED, reload);
  }, [reload]);

  const counts = useMemo(() => studioCounts(agents ?? []), [agents]);
  const shown = useMemo(() => filterStudio(agents ?? [], tab, q), [agents, tab, q]);
  const takenIds = useMemo(() => (agents ?? []).map((a) => a.id), [agents]);

  function changeView(next: "card" | "list") {
    setView(next);
    window.localStorage.setItem(VIEW_KEY, next);
  }

  function setNew(open: boolean) {
    setNewOpen(open);
    // /agents/new 只是「打开弹层」的入口;关掉后回到列表地址,刷新页面不会又弹出来
    if (!open && pathname === "/agents/new") router.replace("/agents");
  }

  function open(agent: StudioAgent) {
    if (agent.canWrite === false) setReadonly(agent);
    else router.push(agentHref({ id: agent.id }));
  }

  /** 软删除:接口调用、分享随之失效;历史会话与运行记录保留(与 Builder 同一个接口) */
  async function confirmDelete() {
    const target = deleting;
    if (!target) return;
    setDeleteBusy(true);
    try {
      await fetchJson(`/api/agents/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      toast.success(`已删除「${target.name}」`);
      setDeleting(null);
      setAgents((list) => list?.filter((a) => a.id !== target.id) ?? list);
      notifyAgentCatalogChanged();
    } catch (e) {
      toast.error(`删除失败：${errorText(e)}`);
    } finally {
      setDeleteBusy(false);
    }
  }

  const newButton = (
    <Button onClick={() => setNew(true)} className="max-md:h-11">
      <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
      新建智能体
    </Button>
  );

  let body: React.ReactNode;
  if (error && !agents) {
    body = (
      <StateBox>
        <p className="mb-1.5 font-display text-[22px] font-bold">智能体列表加载失败</p>
        <p className="mb-5 text-[15px] text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={reload}>
          重试
        </Button>
      </StateBox>
    );
  } else if (!agents) {
    body = (
      <>
        <p
          className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          正在加载智能体…
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 占位骨架没有身份
            <SkeletonCard key={i} />
          ))}
        </div>
      </>
    );
  } else if (agents.length === 0) {
    body = (
      <StateBox>
        <AgentAvatar id="agent-architect" size={64} className="mb-4" />
        <p className="mb-1.5 font-display text-[22px] font-bold">还没有智能体</p>
        <p className="mb-5 max-w-[520px] text-[15px] text-muted-foreground">
          说清规则，智能体设计器帮你配好模型、工具、知识和评测；也可以先去探索里克隆一个现成的。
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          {newButton}
          <Button asChild variant="outline" className="max-md:h-11">
            <Link href="/">去探索看看</Link>
          </Button>
        </div>
      </StateBox>
    );
  } else if (shown.length === 0) {
    const searching = q.trim() !== "";
    body = (
      <StateBox>
        <p className="mb-1.5 font-display text-[22px] font-bold">
          {searching
            ? "没有匹配的智能体"
            : tab === "shared"
              ? "还没有人分享智能体给你"
              : "这里还没有智能体"}
        </p>
        <p className="mb-5 text-[15px] text-muted-foreground">
          {searching
            ? `没有名称、ID 或描述包含「${q.trim()}」的智能体。`
            : tab === "shared"
              ? "别人把智能体分享给你后，会出现在这里。"
              : "新建一个，或者从市场克隆一个现成的。"}
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          {searching && (
            <Button variant="outline" onClick={() => setQ("")} className="max-md:h-11">
              清除搜索
            </Button>
          )}
          {newButton}
        </div>
      </StateBox>
    );
  } else if (view === "card") {
    body = (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((a) => (
          <AgentCard key={a.id} agent={a} onOpenAction={open} onDeleteAction={setDeleting} />
        ))}
      </div>
    );
  } else {
    body = <AgentTable agents={shown} onOpenAction={open} onDeleteAction={setDeleting} />;
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-16 md:px-14 md:pt-[34px]">
        <header className="mb-[22px] flex flex-wrap items-end gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight font-bold md:text-[36px]">
              我的智能体
            </h1>
            <p className="mt-1.5 text-[15px] text-muted-foreground max-md:text-base">
              {agents?.length
                ? `共 ${agents.length} 个，我建的和分享给我的都在这里。点开就进入构建页。`
                : "我建的和分享给我的，都在这里。"}
            </p>
          </div>
          <div className="ml-auto">{newButton}</div>
        </header>

        <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
          <Tabs value={tab} onValueChange={(v) => setTab(v as StudioTab)}>
            <TabsList variant="segment" aria-label="智能体分组">
              {TABS.map(([key, label]) => (
                <TabsTrigger key={key} value={key} className="max-md:h-10">
                  {label}
                  <span className="font-medium text-muted-foreground">
                    {agents ? counts[key] : ""}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative order-last w-full md:order-none md:ml-auto md:w-[280px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称、ID 或描述"
              aria-label="搜索智能体"
              className="rounded-full pl-10 max-md:h-11 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <fieldset className="inline-flex rounded-full bg-secondary p-[3px] max-md:ml-auto">
            <legend className="sr-only">显示方式</legend>
            {(
              [
                ["card", LayoutGrid, "卡片"],
                ["list", List, "列表"],
              ] as const
            ).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                aria-label={label}
                title={label}
                onClick={() => changeView(key)}
                className={cn(
                  "grid h-[30px] w-11 place-items-center rounded-full text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB] max-md:h-10",
                  view === key && "bg-card text-foreground shadow-xs",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            ))}
          </fieldset>
        </div>

        {error && agents && (
          <p className="mb-3 text-sm text-destructive" aria-live="assertive">
            刷新失败：{error}
            <button type="button" className="ml-2 underline" onClick={reload}>
              重试
            </button>
          </p>
        )}
        {body}
      </div>

      <NewAgentDialog
        open={newOpen}
        onOpenChangeAction={setNew}
        initialMode={initialMode}
        initialDesc={initialDesc}
        takenIds={takenIds}
      />
      <ReadonlyDrawer agent={readonly} onOpenChangeAction={(v) => !v && setReadonly(null)} />
      <Dialog open={!!deleting} onOpenChange={(v) => !v && !deleteBusy && setDeleting(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogTitle>删除「{deleting?.name}」？</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-foreground">
              <p className="mb-2">删除后立即生效：</p>
              <ul className="mb-2.5 list-disc pl-[18px] leading-[1.8]">
                <li>通过 API 的接口调用会失败</li>
                <li>
                  分享和公开会失效
                  {deleting?.marketListed ? "，市场上也会下架" : ""}
                </li>
                <li>绑定到它的 API Key 会调不通</li>
              </ul>
              <p className="text-muted-foreground">
                历史会话、运行记录和计费记录会保留。此操作不能在界面上撤销。
              </p>
            </div>
          </DialogDescription>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button variant="outline" disabled={deleteBusy} onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void confirmDelete()}
            >
              {deleteBusy ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
