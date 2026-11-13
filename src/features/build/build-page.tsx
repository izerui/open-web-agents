"use client";

// 构建页(工作室 › 单个智能体):一页、一份自动保存的草稿、五个阶段(编排 / 评测 / 发布 / 接入 / 运行)。
// 左:我的智能体列表;页头:返回、头像、名称与保存状态、阶段切换、上线清单、更多;
// 主体:智能体设计器(主角)+ 当前阶段(编排是档案 / 试聊)。窄屏单栏,设计器从卡片打开。

import { AgentAvatar } from "@/components/agent-avatar";
import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useModelCatalog } from "@/features/builder/model-select";
import { studioAgents } from "@/features/studio/studio-model";
import { notifyAgentCatalogChanged } from "@/lib/agent-catalog";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { agentHref } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AccessStage } from "./access-stage";
import {
  type EvalSummary,
  STAGES,
  type Stage,
  railStatus,
  readonlyHeaderText,
  stageBadges,
  stageParam,
} from "./build-model";
import { useDeleteAgent } from "./delete-agent";
import { type NextStep, type NextTarget, nextStepFor } from "./designer-model";
import { DesignerPanel, DesignerRail } from "./designer-panel";
import { type EvalCase, type EvalResult, EvalStage, fixPromptFrom } from "./eval-stage";
import { ProfileCard, modelLabel } from "./profile-card";
import {
  SECTIONS,
  type SectionContext,
  type SectionKey,
  orchestrationReady,
  parseSchemaText,
  sectionFilled,
  sectionSummary,
} from "./profile-model";
import { PublishStage } from "./publish-stage";
import { READONLY_ACCESS_BADGE, READONLY_STAGES, ReadonlyAccess } from "./readonly-access";
import { ReadonlyView, useClone } from "./readonly-view";
import { RunsStage } from "./runs-stage";
import { TrialPanel } from "./trial-panel";
import { Seg, TextButton } from "./ui";
import { useAgentDraft } from "./use-agent-draft";
import {
  type BuildAgent,
  useAgentList,
  useAgentMeta,
  useAgentUsage,
  useMonthUsed,
} from "./use-build-data";
import { useDesigner } from "./use-designer";

const BUILT_IN = ["default", "agent-architect"];

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function BuildPage({
  agentId: routeId,
  designerSession,
  initialDesc,
  initialFiles,
  initialStage,
}: {
  /** 地址里的智能体;新建态为 undefined */
  agentId?: string;
  designerSession?: string;
  initialDesc?: string;
  /** 已传进设计会话工作区的附件(探索首页带来),随描述一起自动发给设计器 */
  initialFiles?: string[];
  initialStage: Stage;
}) {
  const router = useRouter();
  const list = useAgentList();
  const catalog = useModelCatalog();
  const [createdId, setCreatedId] = useState<string | null>(null);
  const currentId = routeId ?? createdId;
  const agent: BuildAgent | null = currentId
    ? (list.agents.find((a) => a.id === currentId) ?? null)
    : null;
  const notFound = Boolean(routeId) && list.loaded && !list.error && !agent;
  const readOnly = agent?.canWrite === false;
  const canManageWebhook = agent ? agent.canManageWebhook === true : true;
  const takenIds = useMemo(() => list.agents.map((a) => a.id), [list.agents]);

  const [stage, setStageState] = useState<Stage>(initialStage);
  const [rtab, setRtab] = useState<"card" | "trial">("card");
  const [fresh, setFresh] = useState<Set<SectionKey>>(() => new Set());
  // 新建时九节都收起,注意力在设计器上;打开已有的智能体默认展开提示词
  const [open, setOpen] = useState<Set<SectionKey>>(
    () => new Set<SectionKey>(routeId ? ["prompt"] : []),
  );
  /** 设计器底部的「下一步」提示(前端按事件生成) */
  const [next, setNext] = useState<NextStep | null>(null);
  const [evalProgress, setEvalProgress] = useState<{ done: number; total: number } | null>(null);
  const [railQuery, setRailQuery] = useState("");
  const [designerOpen, setDesignerOpen] = useState<boolean | null>(null);
  const [wide, setWide] = useState(false);
  const [mobileDesigner, setMobileDesigner] = useState(false);
  const pendingReset = useRef<string | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const sessionRef = useRef<string>(designerSession ?? "");
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  const replaceUrl = useCallback((id: string | null, s: Stage, designer?: string) => {
    const href = agentHref({
      id: id ?? undefined,
      isNew: !id,
      stage: stageParam(s),
      designer: designer || undefined,
    });
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState(null, "", href);
    }
  }, []);

  const meta = useAgentMeta(readOnly ? null : currentId, {
    canWrite: !readOnly && Boolean(agent),
    publishedVersion: agent?.publishedVersion ?? null,
    hasUnpublishedChanges: agent?.hasUnpublishedChanges === true,
  });
  const usage = useAgentUsage(readOnly || !agent ? null : currentId);
  const monthUsed = useMonthUsed(list.loaded);

  // 草稿评测跑完(不管人在哪个阶段):设计器底部给下一步
  const prevEval = useRef<EvalSummary | null>(null);
  const draftEval = meta.meta.evals?.draft ?? null;
  useEffect(() => {
    const was = prevEval.current?.state;
    prevEval.current = draftEval;
    if (was !== "running" || !draftEval?.run) return;
    if (draftEval.state === "passed" || draftEval.state === "failed") {
      setNext(
        nextStepFor({
          kind: "evalDone",
          passed: draftEval.run.passed,
          total: draftEval.run.total,
        }),
      );
      void usage.reload();
    }
  }, [draftEval, usage.reload]);

  const designerRef = useRef<ReturnType<typeof useDesigner> | null>(null);
  /** 自动保存暂停的原因(设计器写入、载入版本期间);由下面的 effect 跟着设计器状态更新 */
  const [pausedReason, setPausedReason] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const draft = useAgentDraft({
    paused: pausedReason,
    agent: readOnly ? null : agent,
    canManageWebhook,
    takenIds,
    onSaved: (saved, created) => {
      void list.reload();
      void meta.loadVersions();
      if (created) {
        setCreatedId(saved.id);
        notifyAgentCatalogChanged();
        const g = designerRef.current;
        void (async () => {
          if (g?.sessionId && !g.view?.targetId) await g.bindTarget(saved.id);
          replaceUrl(saved.id, stageRef.current, sessionRef.current);
        })();
      } else {
        designerRef.current?.notifyTargetChanged();
      }
    },
  });

  const designer = useDesigner({
    agentId: currentId,
    initialSession: designerSession,
    initialPrompt: initialDesc,
    initialFiles,
    // 自动发过一次之后从地址里去掉 desc:刷新不会再发
    onAutoSent: () => replaceUrl(currentIdRef.current, stageRef.current, sessionRef.current),
    enabled: !readOnly && !notFound && (!routeId || Boolean(agent)),
    beforeApply: async () => {
      if (!currentId) {
        if (draft.dirty)
          return window.confirm(
            "档案里手填的内容还没保存，应用设计器的改动会用设计器的内容建好草稿，继续？",
          );
        return true;
      }
      return draft.flush();
    },
    onApplied: async ({ agentId: aid, created, sections }) => {
      setFresh((s) => new Set([...s, ...sections]));
      if (created || aid !== currentId) {
        setCreatedId(aid);
        notifyAgentCatalogChanged();
        replaceUrl(aid, stageRef.current, sessionRef.current);
      }
      pendingReset.current = aid;
      await list.reload();
      void meta.loadVersions();
      const titles = sections.map((k) => SECTIONS.find((s) => s.key === k)?.title ?? k);
      toast.success(`已应用到草稿：${titles.join("、")}`);
      setNext(nextStepFor({ kind: "applied", sections: titles }));
    },
    onSessionChange: (sid) => {
      sessionRef.current = sid ?? "";
      replaceUrl(currentId, stageRef.current, sid ?? undefined);
    },
  });
  designerRef.current = designer;

  // 设计器写入、载入版本期间:表单锁住、自动保存暂停 —— 这段时间的输入会被随后的结果覆盖,
  // 存下去又会把刚写进去的内容改回去
  const pauseNow =
    designer.working !== null ? "智能体设计器正在写入草稿" : restoring ? "正在载入所选版本" : null;
  useEffect(() => setPausedReason(pauseNow), [pauseNow]);

  // 设计器应用之后:表单从服务端的最新内容重新开始
  useEffect(() => {
    const id = pendingReset.current;
    if (!id) return;
    const a = list.agents.find((x) => x.id === id);
    if (a) {
      pendingReset.current = null;
      draft.resetFrom(a);
    }
  }, [list.agents, draft.resetFrom]);

  const setStage = useCallback(
    (s: Stage) => {
      setStageState(s);
      if (s !== "orch") setWide(false);
      replaceUrl(currentId, s, sessionRef.current);
    },
    [currentId, replaceUrl],
  );

  const goSection = useCallback(
    (k: SectionKey) => {
      setStage("orch");
      setRtab("card");
      setWide(false);
      setOpen((o) => new Set(o).add(k));
      setTimeout(() => {
        document
          .querySelector(`[data-sec="${k}"]`)
          ?.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 60);
    },
    [setStage],
  );

  const fixWithDesigner = useCallback(
    (prompt: string) => {
      setNext(null);
      setDesignerOpen(true);
      if (window.matchMedia("(max-width: 1023px)").matches) setMobileDesigner(true);
      designer.setPrompt(prompt);
      if (designer.blocked) {
        toast.message("设计器正忙，修复要求已填进输入框，稍后发送");
      } else {
        void designer.send(prompt);
      }
    },
    [designer],
  );

  const d = draft.draft;
  const ctx: SectionContext = {
    exists: currentId !== null,
    canManageWebhook,
    modelLabel: modelLabel(catalog, d.model),
    knowledge: meta.meta.knowledge,
  };
  const filled = SECTIONS.filter((s) => sectionFilled(s.key, d, ctx)).length;
  const ready = orchestrationReady(d);
  const badges = stageBadges({
    readOnly,
    filled,
    caseCount: meta.meta.caseCount,
    draftEval,
    evalProgress,
    publishedVersion: agent?.publishedVersion ?? null,
    hasUnpublishedChanges: agent?.hasUnpublishedChanges === true,
    changeCount: meta.meta.changeCount,
    keyCount: meta.meta.keys.length,
    // 与运行阶段统计卡同一口径:近 7 天、计费在你名下的运行
    runs7d: currentId ? (usage.stats?.runs ?? null) : 0,
  });
  const pendingCount = designer.pending.reduce((n, p) => n + p.changes.length, 0);
  const designerVisible =
    designerOpen ?? (stage === "orch" || stage === "eval" || stage === "publish");
  const name = (readOnly ? agent?.name : d.name.trim()) || agent?.name || "新智能体";
  const icon = readOnly ? agent?.icon : d.icon || agent?.icon;
  const avatarId = currentId ?? (d.id || "new-agent");
  const contract = agent?.published ?? agent?.config;
  const deletable = Boolean(agent && canManageWebhook && !BUILT_IN.includes(agent.id));
  const clone = useClone(agent);
  const del = useDeleteAgent(currentId, name);

  /** 「下一步」按钮的去处 */
  const goNext = async (to: NextTarget) => {
    if (to === "trial") {
      setStage("orch");
      setRtab("trial");
      setWide(false);
      setNext(null);
      return;
    }
    if (to !== "fix") {
      setStage(to);
      setNext(null);
      return;
    }
    // 让设计器修复:取最近一次对草稿的评测里没过的用例
    const runId = draftEval?.run?.id;
    if (!currentId || !runId) return setStage("eval");
    try {
      const base = `/api/agents/${encodeURIComponent(currentId)}/evals`;
      const [r, c] = await Promise.all([
        fetchJson<{ results: EvalResult[] }>(`${base}/runs/${runId}`),
        fetchJson<{ cases: EvalCase[] }>(`${base}/cases`),
      ]);
      const bad = r.results.filter((x) => x.status === "failed" || x.status === "error");
      if (bad.length) fixWithDesigner(fixPromptFrom(c.cases, bad));
      else setStage("eval");
    } catch (e) {
      toast.error(`读取评测结果失败：${errorText(e)}`);
    }
  };

  /** 页头的保存状态 */
  const saveLabel = (() => {
    if (readOnly)
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Lock className="size-3.5" />
          {readonlyHeaderText(agent ?? null)}
        </span>
      );
    if (designer.working !== null)
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          智能体设计器正在写入草稿…
        </span>
      );
    if (draft.auto.phase === "saving" || draft.auto.phase === "pending")
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          保存中…
        </span>
      );
    if (draft.stale)
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">草稿已在别处修改，自动保存已停</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => {
              if (!currentId) return;
              pendingReset.current = currentId;
              void list.reload();
            }}
          >
            载入最新版本
          </button>
        </span>
      );
    if (draft.auto.phase === "error")
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">保存失败：{draft.auto.error}</span>
          <button type="button" className="shrink-0 underline" onClick={draft.retry}>
            重试
          </button>
        </span>
      );
    if (draft.block && (draft.dirty || !currentId)) {
      const text =
        !currentId && !d.name.trim() && !d.systemPrompt.trim()
          ? "填好名称和提示词后自动保存"
          : `暂停保存：${draft.block.reason}`;
      const sec = draft.block.section;
      return (
        <button
          type="button"
          onClick={() => goSection(sec)}
          className="flex min-w-0 items-center gap-1.5 text-warning-text underline-offset-2 hover:underline"
        >
          <Info className="size-3.5 shrink-0" />
          <span className="truncate">{text}</span>
        </button>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Check className="size-3.5" strokeWidth={2.2} />
        {draft.auto.savedAt ? `草稿自动保存于 ${clock(draft.auto.savedAt)}` : "改动会自动保存"}
      </span>
    );
  })();

  const openAgent = async (id: string) => {
    if (id === currentId) return;
    if (draft.dirty && !draft.block) await draft.flush();
    router.push(agentHref({ id }));
  };

  // ───────────── 左栏:我的智能体 ─────────────
  const rail = studioAgents(list.agents);
  const q = railQuery.trim().toLowerCase();
  const railShown = q
    ? rail.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    : rail;
  const leftList = (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-border max-xl:hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3.5 py-4">
        <div className="flex items-center justify-between px-2 pt-1 pb-2.5 text-[13px] text-muted-foreground">
          <span>我的智能体（{rail.length}）</span>
          <Link
            href="/agents/new"
            className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-[13px] text-[#4D4A43] hover:bg-accent"
          >
            <Plus className="size-3.5" />
            新建
          </Link>
        </div>
        {rail.length > 8 && (
          <div className="relative mb-1.5 px-0.5">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索我的智能体"
              className="h-8 pl-8 text-[13px]"
              value={railQuery}
              onChange={(e) => setRailQuery(e.target.value)}
              placeholder="搜索名称或 ID"
            />
          </div>
        )}
        {!currentId && (
          <div className="flex items-center gap-2.5 rounded-[14px] border border-border bg-card px-2.5 py-[9px] shadow-[0_1px_3px_rgba(0,0,0,.04)]">
            <AgentAvatar id={avatarId} icon={icon} size={34} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{d.name.trim() || "新智能体"}</div>
              <div className="text-xs text-muted-foreground">草稿，未保存</div>
            </div>
          </div>
        )}
        {!list.loaded && <p className="px-2 text-[13px] text-muted-foreground">正在加载…</p>}
        {q && railShown.length === 0 && (
          <p className="px-2 text-[13px] text-muted-foreground">没有匹配的智能体</p>
        )}
        {railShown.map((a) => {
          const st = railStatus(a);
          const on = a.id === currentId;
          return (
            <button
              key={a.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => void openAgent(a.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-[14px] border border-transparent px-2.5 py-[9px] text-left hover:bg-accent",
                on && "border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,.04)] hover:bg-card",
              )}
            >
              <AgentAvatar id={a.id} icon={on && !readOnly ? icon : a.icon} size={34} />
              <div className="min-w-0">
                <div className="truncate text-sm leading-tight font-medium">
                  {on && !readOnly ? name : a.name}
                </div>
                <div
                  className={cn(
                    "truncate text-xs leading-snug text-muted-foreground",
                    st.tone === "ok" && "text-success-text",
                    st.tone === "warn" && "text-warning-text",
                  )}
                >
                  {st.text}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-line-soft px-5 py-3 text-[13px] text-muted-foreground">
        {monthUsed !== null ? (
          <>
            本月已用{" "}
            <Link
              href="/account/billing"
              className="text-foreground underline-offset-2 hover:underline"
            >
              {creditsAmount(monthUsed)}
            </Link>{" "}
            积分
          </>
        ) : (
          "本月用量读取中…"
        )}
      </div>
    </aside>
  );

  // ───────────── 页头 ─────────────
  const stageNav = (
    <nav
      aria-label="构建阶段"
      className={`flex shrink-0 items-center gap-0.5 rounded-3xl bg-[#ECEAE3] p-1 max-md:w-max max-sm:grid max-sm:w-full max-sm:rounded-[18px] ${readOnly ? "max-sm:grid-cols-2" : "max-sm:grid-cols-5"}`}
    >
      {(readOnly ? READONLY_STAGES : STAGES).map((s) => {
        const b = readOnly && s.key === "access" ? READONLY_ACCESS_BADGE : badges[s.key];
        const on = stage === s.key;
        return (
          <button
            key={s.key}
            type="button"
            aria-current={on ? "step" : undefined}
            title={`${s.label}：${b.text}`}
            onClick={() => setStage(s.key)}
            className={cn(
              "flex h-10 items-center gap-2 rounded-[20px] px-3.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground max-2xl:px-2.5 max-sm:h-auto max-sm:min-h-12 max-sm:min-w-0 max-sm:flex-col max-sm:justify-center max-sm:gap-0.5 max-sm:rounded-[14px] max-sm:px-1 max-sm:py-1",
              on && "bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,.07)]",
            )}
          >
            <span className="font-semibold">{s.label}</span>
            <span
              className={cn(
                "rounded-[10px] bg-[#E2DFD7] px-2 py-px text-xs text-[#4D4A43] max-sm:max-w-full max-sm:truncate max-sm:px-1.5",
                b.tone === "ok" && "bg-success-soft text-success-text",
                b.tone === "warn" && "bg-warning-soft text-warning-text",
                b.tone === "bad" && "bg-destructive-soft text-destructive",
              )}
            >
              {b.text}
            </span>
          </button>
        );
      })}
    </nav>
  );

  const header = (
    <header className="flex min-h-16 shrink-0 items-center gap-3.5 border-b border-border px-[22px] max-lg:flex-wrap max-lg:gap-x-3 max-lg:gap-y-2 max-lg:px-3 max-lg:py-2.5">
      <Link
        href="/agents"
        aria-label="返回工作室"
        title="返回工作室"
        className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-accent max-md:size-11"
      >
        <ChevronLeft className="size-5" />
      </Link>
      <AgentAvatar id={avatarId} icon={icon} size={40} />
      <div className="min-w-0 max-w-[240px] flex-1 max-lg:max-w-none">
        <div className="truncate font-display text-[19px] leading-tight font-bold">{name}</div>
        <div className="text-xs leading-tight">{saveLabel}</div>
      </div>
      <div className="mx-auto max-w-full overflow-x-auto max-lg:order-last max-lg:mx-0 max-lg:w-full max-sm:overflow-visible [scrollbar-width:none]">
        {stageNav}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2 max-lg:ml-0">
        {readOnly ? (
          <Button
            disabled={clone.busy || !clone.can}
            title={clone.reason || undefined}
            onClick={clone.clone}
          >
            <Copy />
            <span className="max-sm:hidden">克隆一份来改</span>
          </Button>
        ) : (
          <Button onClick={() => setStage("publish")}>
            <Check strokeWidth={2.2} />
            <span className="max-sm:hidden">上线清单</span>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="更多操作"
              className="grid size-10 place-items-center rounded-full border border-border bg-card hover:bg-[#F2F0EA] max-md:size-11"
            >
              <MoreHorizontal className="size-[18px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {currentId && (
              <DropdownMenuItem asChild>
                <Link href={`/chat?agent=${encodeURIComponent(currentId)}`}>
                  <MessageSquare />
                  在对话里使用
                </Link>
              </DropdownMenuItem>
            )}
            {currentId && !readOnly && (
              <DropdownMenuItem
                onSelect={() => {
                  setStage("orch");
                  setRtab("trial");
                  setWide(false);
                }}
              >
                <MessageSquare />
                用草稿试聊
              </DropdownMenuItem>
            )}
            {currentId && (
              <DropdownMenuItem
                disabled={clone.busy || !clone.can}
                onSelect={clone.clone}
                className="flex-wrap"
              >
                <Copy />
                克隆一份
                {!clone.can && (
                  <span className="basis-full pl-6 text-xs text-muted-foreground">
                    {clone.reason}
                  </span>
                )}
              </DropdownMenuItem>
            )}
            {currentId && (
              <DropdownMenuItem
                onSelect={() =>
                  void navigator.clipboard.writeText(currentId).then(
                    () => toast.success("ID 已复制"),
                    () => toast.error("复制失败"),
                  )
                }
              >
                <Copy />
                复制 ID
              </DropdownMenuItem>
            )}
            {!readOnly && (
              <DropdownMenuItem asChild>
                <Link href="/developer/keys">
                  <KeyRound />
                  全部 API Key
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link href="/agents">
                <ChevronLeft />
                回到工作室
              </Link>
            </DropdownMenuItem>
            {deletable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={del.ask}>
                  <Trash2 />
                  删除智能体
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );

  // ───────────── 主体 ─────────────
  const goStage = (s: Stage) => setStage(s);
  const profile = (
    // 设计器写入、载入版本期间锁住表单(见 pauseNow)
    <fieldset disabled={pauseNow !== null} className="min-w-0 disabled:opacity-70">
      <ProfileCard
        draft={d}
        set={draft.set}
        onIdEditing={draft.setIdEditing}
        update={draft.update}
        agentId={currentId}
        canManageWebhook={canManageWebhook}
        sharedWrite={Boolean(agent && !agent.isOwner && !BUILT_IN.includes(agent.id))}
        ownerName={agent?.ownerName}
        publishedVersion={agent?.publishedVersion ?? null}
        changeCount={meta.meta.changeCount}
        catalog={catalog}
        stdio={list.stdio}
        knowledge={meta.meta.knowledge}
        onKnowledgeChanged={() => void meta.loadKnowledge()}
        fresh={fresh}
        onEdited={(k) =>
          setFresh((s) => {
            if (!s.has(k)) return s;
            const n = new Set(s);
            n.delete(k);
            return n;
          })
        }
        open={open}
        onToggle={(k, value) =>
          setOpen((o) => {
            const n = new Set(o);
            const want = value ?? !n.has(k);
            if (want) n.add(k);
            else n.delete(k);
            return n;
          })
        }
        takenIds={takenIds}
        designer={designer}
        sources={list.agents
          .filter((a) => a.canWrite !== false && a.id !== currentId && !BUILT_IN.includes(a.id))
          .map((a) => ({ id: a.id, name: a.name, icon: a.icon }))}
        goStage={goStage}
      />
    </fieldset>
  );

  const stageBody = (() => {
    switch (stage) {
      case "eval":
        return (
          <EvalStage
            agentId={currentId}
            publishedVersion={agent?.publishedVersion ?? null}
            versions={meta.meta.versions}
            draftEval={meta.meta.evals?.draft ?? null}
            hasInputSchema={(() => {
              const r = parseSchemaText(d.inputSchemaText);
              return r.ok && !r.empty;
            })()}
            beforeRun={draft.flush}
            onChanged={() => {
              void meta.loadVersions();
              void usage.reload();
            }}
            onFix={fixWithDesigner}
            goStage={goStage}
            credits={usage.credits}
            onProgress={setEvalProgress}
          />
        );
      case "publish":
        return (
          <PublishStage
            agentId={currentId}
            agentName={name}
            ready={ready}
            filled={filled}
            caseCount={meta.meta.caseCount}
            draftEval={meta.meta.evals?.draft ?? null}
            versions={meta.meta.versions}
            versionEvals={meta.meta.evals?.versions ?? {}}
            publishedVersion={agent?.publishedVersion ?? null}
            hasUnpublishedChanges={agent?.hasUnpublishedChanges === true}
            changeCount={meta.meta.changeCount}
            keyCount={meta.meta.keys.length}
            saving={draft.auto.phase === "saving" || draft.auto.phase === "pending"}
            canManage={canManageWebhook}
            listed={agent?.marketListed === true}
            beforePublish={draft.flush}
            onPublished={(v) => {
              void list.reload();
              void meta.loadVersions();
              setNext(nextStepFor({ kind: "published", version: v }));
            }}
            onRestored={() => {
              if (currentId) pendingReset.current = currentId;
              setRestoring(true);
              void list.reload().finally(() => setRestoring(false));
              void meta.loadVersions();
              designer.notifyTargetChanged();
            }}
            onChanged={() => {
              void list.reload();
              void meta.loadVersions();
            }}
            onRecheck={() => {
              void list.reload();
              void meta.loadVersions();
              void meta.loadKeys();
              void meta.loadChanges();
            }}
            goStage={goStage}
            onFix={() => setStage("eval")}
          />
        );
      case "access":
        return (
          <AccessStage
            agentId={currentId}
            agentName={name}
            publishedVersion={agent?.publishedVersion ?? null}
            hasUnpublishedChanges={agent?.hasUnpublishedChanges === true}
            changeCount={meta.meta.changeCount}
            inputSchema={contract?.inputSchema as Record<string, unknown> | undefined}
            outputSchema={contract?.outputSchema as Record<string, unknown> | undefined}
            versions={meta.meta.versions}
            keys={meta.meta.keys}
            rateLimits={meta.meta.rateLimits}
            canManageWebhook={canManageWebhook}
            webhookUrl={agent?.webhookUrl}
            onKeysChanged={() => void meta.loadKeys()}
            goStage={goStage}
            openWebhookSection={() => goSection("webhook")}
          />
        );
      case "runs":
        return (
          <RunsStage
            agentId={currentId}
            agentList={{
              agents: list.agents,
              loaded: list.loaded,
              error: list.error,
              reload: list.reload,
            }}
            stats={usage.stats}
            error={usage.error}
          />
        );
      default:
        return null;
    }
  })();

  const outline = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-[18px] py-3">
        <b>档案</b>
        <span className="text-xs text-muted-foreground">草稿，点一节回到编辑</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className="mb-2.5 flex items-center gap-2.5">
          <AgentAvatar id={avatarId} icon={icon} size={40} />
          <div className="min-w-0">
            <div className="truncate font-display text-[17px]">{name}</div>
            <div className="text-xs text-muted-foreground">
              {filled}/9 节
              {(meta.meta.changeCount ?? 0) > 0 ? `，${meta.meta.changeCount} 处未发布修改` : ""}
            </div>
          </div>
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => goSection(s.key)}
            className={cn(
              "mb-1 flex w-full items-start gap-2.5 rounded-xl border border-transparent p-2.5 text-left hover:bg-[#F6F5F1]",
              fresh.has(s.key) && "border-[#F1DDB0] bg-fresh",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {s.title}
                {fresh.has(s.key) && (
                  <span className="inline-flex h-5 items-center rounded-full bg-[#FBE7BD] px-1.5 text-xs font-normal text-[#7A4F0C]">
                    刚更新
                  </span>
                )}
              </span>
              <span className="line-clamp-2 text-[12.5px] text-muted-foreground">
                {sectionSummary(s.key, d, ctx)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  const orchRight =
    wide && designerVisible ? (
      outline
    ) : (
      <>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft px-[18px] py-3 max-md:px-3">
          <Seg
            ariaLabel="档案或试聊"
            options={[
              ["card", "档案"],
              ["trial", "试聊"],
            ]}
            value={rtab}
            onChange={setRtab}
          />
          <span className="text-[13px] text-muted-foreground max-sm:hidden">
            {rtab === "card"
              ? "每一节都能点开直接改，改动自动保存"
              : "用当前草稿对话，结果可存为评测用例"}
          </span>
        </div>
        {rtab === "card" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 max-md:px-3.5">
            {profile}
          </div>
        ) : (
          <TrialPanel
            agentId={currentId}
            agentName={name}
            agentIcon={icon}
            starters={d.startersText
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 4)}
            ready={ready}
            modelText={modelLabel(catalog, d.model)}
            hasInputSchema={(() => {
              const r = parseSchemaText(d.inputSchemaText);
              return r.ok && !r.empty;
            })()}
            beforeSend={draft.flush}
            onCaseSaved={() => {
              void meta.loadVersions();
              setNext(nextStepFor({ kind: "caseSaved", count: meta.meta.caseCount + 1 }));
            }}
            credits={usage.credits}
            onTurnFinished={() => void usage.reload()}
          />
        )}
      </>
    );

  const designerPanel = (mode: "normal" | "wide" | "sheet") => (
    <DesignerPanel
      designer={designer}
      mode={mode}
      canWide={stage === "orch" && mode !== "sheet"}
      onToggleWide={() => setWide((w) => !w)}
      onCollapse={mode === "sheet" ? undefined : () => setDesignerOpen(false)}
      targetName={name}
      next={next}
      onNext={(to) => {
        if (mode === "sheet") setMobileDesigner(false);
        void goNext(to);
      }}
      onDismissNext={() => setNext(null)}
    />
  );

  let body: React.ReactNode;
  if (routeId && !list.loaded) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在加载智能体…
      </div>
    );
  } else if (list.error && !agent) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
        <p className="m-0 text-destructive">智能体列表加载失败：{list.error}</p>
        <Button variant="outline" onClick={() => void list.reload()}>
          重试
        </Button>
      </div>
    );
  } else if (notFound) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="font-display text-xl">找不到这个智能体</div>
        <p className="m-0 text-sm text-muted-foreground">它可能已被删除，或者你没有访问权限。</p>
        <Button asChild variant="outline">
          <Link href="/agents">回到工作室</Link>
        </Button>
      </div>
    );
  } else if (readOnly && agent) {
    body = stage === "access" ? <ReadonlyAccess agent={agent} /> : <ReadonlyView agent={agent} />;
  } else {
    const isWide = stage === "orch" && wide && designerVisible;
    body = (
      <div className="flex min-h-0 flex-1 gap-4 p-4 max-lg:p-0">
        <div className={cn("flex min-h-0 max-lg:hidden", isWide && "min-w-0 flex-1")}>
          {designerVisible ? (
            designerPanel(isWide ? "wide" : "normal")
          ) : (
            <DesignerRail onOpen={() => setDesignerOpen(true)} pending={pendingCount} />
          )}
        </div>
        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-border bg-card max-lg:rounded-none max-lg:border-0",
            isWide && "w-[340px] flex-none",
          )}
        >
          <button
            type="button"
            onClick={() => setMobileDesigner(true)}
            className="m-3 mb-0 flex items-center gap-3 rounded-[18px] border-[1.5px] border-foreground bg-card px-4 py-3 text-left lg:hidden"
          >
            <AgentAvatar id="agent-architect" size={40} />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-base font-bold">智能体设计器</span>
              <span className="block text-[13px] text-muted-foreground">
                {pendingCount > 0
                  ? `有 ${designer.pending.length} 节改动等你确认`
                  : next
                    ? `下一步：${next.actions.map((a) => a.label).join(" / ")}`
                    : "说说要改什么，它会提问、给差异，确认后写进草稿"}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0" />
          </button>
          {stage === "orch" ? (
            orchRight
          ) : (
            <div
              key={stage}
              className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 max-md:px-3.5"
            >
              {stageBody}
            </div>
          )}
        </section>
        <Sheet open={mobileDesigner} onOpenChange={setMobileDesigner}>
          <SheetContent
            side="right"
            className="w-full gap-0 p-0 sm:max-w-full"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">智能体设计器</SheetTitle>
            <SheetDescription className="sr-only">用对话修改这个智能体</SheetDescription>
            <div className="flex shrink-0 items-center border-b border-border bg-card px-2 py-1">
              <TextButton onClick={() => setMobileDesigner(false)}>
                <ChevronLeft />
                回到{STAGES.find((s) => s.key === stage)?.label}
              </TextButton>
            </div>
            <div className="min-h-0 flex-1">{designerPanel("sheet")}</div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <AppShell fullBleed>
      <div className="flex min-h-0 flex-1">
        {leftList}
        <section className="flex min-w-0 flex-1 flex-col">
          {header}
          {body}
        </section>
      </div>
      {del.dialog}
    </AppShell>
  );
}
