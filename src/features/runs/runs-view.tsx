"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { MessageResponse } from "@/components/ai-elements/message";
import { useConfirm } from "@/components/confirm-dialog";
import { SpaceShell } from "@/components/space-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { filterParam } from "@/features/admin/account-links";
import { EmptyState, SpacePage, tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import { Copy, ExternalLink, Loader2, MessageSquare, RefreshCw, Square, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type RunStatus,
  canCancelRun,
  formatDuration,
  hasChatTranscript,
  looksLikeJson,
  prettyInput,
  runCreditsText,
  tokensText,
  versionLabel,
} from "./run-format";

interface RunItem {
  id: string;
  sessionId: string;
  agentId: string;
  agentName?: string;
  /** 执行的智能体版本;undefined = 草稿 */
  agentVersion?: number;
  source: "web" | "api" | "invoke" | "try" | "eval" | "design" | "trial";
  status: RunStatus;
  promptPreview: string;
  createdAt: number;
  durationMs?: number;
  cost?: { usd?: number; input?: number; output?: number; partial?: boolean };
  /** 扣费积分(settled 实扣 / open 冻结中);不计费的运行没有 */
  credits?: { micro: string; state: string };
  /** 计费账号:只有平台运行(管理员 scope=all)带 */
  account?: { id: string; email?: string };
  error?: { kind?: string; message?: string };
}

interface RunDetail extends RunItem {
  prompt: string;
  /** 会话是私有的:管理员看别人的运行时为 false(见 /api/runs/[id]) */
  canOpenSession?: boolean;
  finalText?: string;
  structured?: unknown;
}

export type AgentLite = { id: string; name: string; icon?: string; canRead?: boolean };

const SOURCE_LABEL: Record<RunItem["source"], string> = {
  web: "工作台",
  api: "API 会话",
  invoke: "接口调用",
  try: "在线试调",
  eval: "评测",
  design: "智能体设计器",
  trial: "构建页试聊",
};

const STATUS_META: Record<
  RunStatus,
  { label: string; variant: "default" | "warning" | "success" | "destructive" | "outline" }
> = {
  pending: { label: "排队中", variant: "default" },
  running: { label: "运行中", variant: "warning" },
  success: { label: "成功", variant: "success" },
  failed: { label: "失败", variant: "destructive" },
  cancelled: { label: "已取消", variant: "outline" },
};

function StatusBadge({ status }: { status: RunStatus }) {
  const m = STATUS_META[status];
  return (
    <Badge variant={m.variant}>
      {status === "running" && <Loader2 className="animate-spin" />}
      {m.label}
    </Badge>
  );
}

function VersionBadge({ version }: { version?: number }) {
  return (
    <Badge variant={version ? "outline" : "warning"} className="font-normal">
      {versionLabel(version)}
    </Badge>
  );
}

/**
 * 运行记录的三个入口:
 * - 开发者 · 运行记录(本人计费的全部运行)—— DeveloperRunsView,直接用 AppShell
 * - 构建页「运行」阶段(单个智能体)与平台管理 · 平台运行 —— RunsView,仍在 SpaceShell 里(阶段 5、7 再换)
 * 三处共用 RunsPanel:筛选、列表、详情抽屉与取消运行。
 */
export function RunsView({
  platform = false,
  agentId,
}: { platform?: boolean; agentId?: string } = {}) {
  const searchParams = useSearchParams();
  // 构建页的「运行」阶段直接传入智能体;旧的 ?agent= 仍然认
  const requestedAgent = agentId ?? searchParams.get("agent");
  // 平台运行从账号详情跳过来时带 ?account=,进来就按这个账号筛
  const initialAccountId = platform ? filterParam(searchParams, "account") : "";
  // Changing objects resets the result list, pagination and detail together.
  return (
    <RunsInShell
      key={JSON.stringify([platform, requestedAgent])}
      requestedAgent={requestedAgent}
      platform={platform}
      initialAccountId={initialAccountId}
    />
  );
}

/** 智能体列表(筛选与对象页头共用)。放在外壳一层:对象页头出现时外壳会换结构,面板随之重挂载,状态不能放在面板里 */
function useAgentList(): AgentList {
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoaded(false);
    setError(null);
    try {
      const d = await fetchJson<{ agents?: AgentLite[] }>("/api/agents");
      setAgents(d.agents ?? []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { agents, loaded, error, reload };
}

/** 平台运行的「全部账号」筛选用的账号列表;个人运行记录不拉 */
function usePlatformAccounts(platform: boolean): { id: string; email: string }[] {
  const [accounts, setAccounts] = useState<{ id: string; email: string }[]>([]);
  useEffect(() => {
    if (!platform) return;
    let alive = true;
    fetchJson<{ accounts?: { id: string; email: string }[] }>("/api/admin/accounts")
      .then((d) => {
        if (alive) setAccounts(d.accounts ?? []);
      })
      // 账号列表没拉到只影响筛选,列表本身照常显示
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [platform]);
  return accounts;
}

export type AgentList = {
  agents: AgentLite[];
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

export function DeveloperRunsView() {
  const list = useAgentList();
  // 带非空 ?agent= 的地址已重定向到构建页;还留着 ?agent=(空 ID)说明链接坏了,提示缺少 ID,不悄悄显示全部运行
  const requestedAgent = useSearchParams().get("agent");
  return (
    <SpacePage
      side="developer"
      title="运行记录"
      subtitle="计费在你名下的全部运行，包括你调用别人的智能体、别人用你的 Key 调用。单个智能体的运行分析在它的构建页「运行」阶段。"
    >
      <RunsPanel
        key={JSON.stringify(requestedAgent)}
        requestedAgent={requestedAgent}
        platform={false}
        agentList={list}
      />
    </SpacePage>
  );
}

function RunsInShell({
  requestedAgent,
  platform,
  initialAccountId,
}: { requestedAgent: string | null; platform: boolean; initialAccountId: string }) {
  const list = useAgentList();
  const objectMode = requestedAgent !== null;
  return (
    <SpaceShell
      title={platform ? "平台运行" : objectMode ? "运行记录" : "全部运行"}
      area={platform ? "admin" : "personal"}
      subtitle={
        platform
          ? objectMode
            ? "此智能体在全平台的运行"
            : "全平台运行，包括工作台、接口调用与评测"
          : objectMode
            ? "此智能体下计费在你名下的运行"
            : "计费在你名下的全部运行，包括工作台、接口调用与评测"
      }
      width={objectMode ? "full" : "wide"}
    >
      <RunsPanel
        requestedAgent={requestedAgent}
        platform={platform}
        agentList={list}
        initialAccountId={initialAccountId}
      />
    </SpaceShell>
  );
}

export function RunsPanel({
  requestedAgent,
  platform,
  agentList,
  initialAccountId = "",
}: {
  requestedAgent: string | null;
  platform: boolean;
  agentList: AgentList;
  /** 平台运行的初始账号筛选(来自地址 ?account=) */
  initialAccountId?: string;
}) {
  const objectMode = requestedAgent !== null;
  const confirm = useConfirm();
  const { agents, loaded: agentsLoaded, error: agentsError, reload: loadAgents } = agentList;
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  /** 平台运行按账号筛选;空 = 全部账号 */
  const [accountId, setAccountIdState] = useState(platform ? initialAccountId : "");
  const accounts = usePlatformAccounts(platform);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  /** 换账号筛选时同步写进地址 ?account=(不新增历史记录),刷新、分享都还在这个账号 */
  function setAccountId(id: string) {
    setAccountIdState(id);
    if (!platform) return;
    const q = new URLSearchParams(searchParams.toString());
    if (id) q.set("account", id);
    else q.delete("account");
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  }
  const [items, setItems] = useState<RunItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const seqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const selectedAgent = objectMode ? agents.find((a) => a.id === requestedAgent) : undefined;
  const effectiveAgentId = objectMode ? selectedAgent?.id : agentId;
  const canLoad = !objectMode || Boolean(selectedAgent);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const contextError =
    objectMode && agentsLoaded && !agentsError && !selectedAgent
      ? requestedAgent
        ? "找不到指定的智能体,它可能已被删除或你没有访问权限。"
        : "链接缺少智能体 ID,请选择智能体后再查看运行。"
      : null;

  const load = useCallback(
    async (append?: string): Promise<boolean> => {
      if (!canLoad) return false;
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      if (!append) {
        setItems([]);
        setCursor(undefined);
      }
      const q = new URLSearchParams({ limit: "30" });
      if (platform) q.set("scope", "all");
      if (platform && accountId) q.set("accountId", accountId);
      if (effectiveAgentId) q.set("agentId", effectiveAgentId);
      if (status) q.set("status", status);
      if (source) q.set("source", source);
      if (append) q.set("cursor", append);
      try {
        const d = await fetchJson<{ items: RunItem[]; nextCursor?: string }>(`/api/runs?${q}`);
        if (seq !== seqRef.current) return false;
        setItems((cur) => (append ? [...cur, ...d.items] : d.items));
        setCursor(d.nextCursor);
        return true;
      } catch (e) {
        if (seq === seqRef.current) setError(errorText(e));
        return false;
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [canLoad, effectiveAgentId, status, source, platform, accountId],
  );

  useEffect(() => {
    void load();
    return () => {
      seqRef.current++;
      detailSeqRef.current++;
    };
  }, [load]);

  async function openDetail(id: string) {
    const seq = ++detailSeqRef.current;
    setDetailError(null);
    try {
      const d = await fetchJson<{ run: RunDetail }>(`/api/runs/${encodeURIComponent(id)}`);
      if (seq === detailSeqRef.current) setDetail(d.run);
    } catch (e) {
      if (seq === detailSeqRef.current) setDetailError(errorText(e));
    }
  }

  async function cancelRun(run: RunDetail) {
    setCancelling(true);
    try {
      const r = await fetchJson<{ cancelled: boolean; note?: string }>(
        `/api/runs/${encodeURIComponent(run.id)}/cancel`,
        { method: "POST" },
      );
      if (r.cancelled) toast.success("运行已取消");
      else toast.message(r.note ?? "运行已结束,无需取消");
      await Promise.all([load(), openDetail(run.id)]);
    } catch (e) {
      toast.error(`取消失败:${errorText(e)}`);
    } finally {
      setCancelling(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("taskId 已复制");
    } catch (e) {
      toast.error(`复制失败:${errorText(e)}`);
    }
  }

  const filtered = Boolean(agentId || status || source || accountId);
  const detailAgent = detail ? agentById.get(detail.agentId) : undefined;

  return (
    <>
      {agentsError && (
        <Alert variant="destructive" className="mb-3 flex flex-wrap items-center gap-2">
          智能体列表加载失败:{agentsError}
          <Button size="sm" variant="outline" onClick={() => void loadAgents()}>
            重试
          </Button>
        </Alert>
      )}
      {contextError && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{contextError}</AlertDescription>
        </Alert>
      )}
      {objectMode && !selectedAgent && (
        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          {!agentsLoaded && <p className="text-muted-foreground">正在加载智能体…</p>}
          <Link href="/agents" className="underline">
            选择智能体
          </Link>
          <Link href={platform ? "/admin/ops?tab=runs" : "/developer/runs"} className="underline">
            {platform ? "查看全部平台运行" : "查看我的全部运行"}
          </Link>
        </div>
      )}
      {detailError && (
        <p aria-live="polite" className="mb-3 text-sm text-destructive">
          运行详情没有读到:{detailError}
        </p>
      )}
      {canLoad && (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            {platform && (
              <NativeSelect
                className="w-auto max-w-60 min-w-[150px] max-sm:w-full max-sm:max-w-none"
                aria-label="按账号筛选"
                value={accountId}
                disabled={accounts.length === 0}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">全部账号</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </NativeSelect>
            )}
            {!objectMode && (
              <NativeSelect
                className="w-auto max-w-60 min-w-[150px] max-sm:w-full max-sm:max-w-none"
                aria-label="按智能体筛选"
                value={effectiveAgentId}
                disabled={!agentsLoaded || Boolean(agentsError)}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">全部智能体</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <NativeSelect
              className="w-auto min-w-[150px] max-sm:flex-1"
              aria-label="按状态筛选"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(STATUS_META).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              className="w-auto min-w-[150px] max-sm:flex-1"
              aria-label="按来源筛选"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">全部来源</option>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
            {!loading && !error && (
              <span className="text-xs text-muted-foreground">
                {items.length} 条{cursor ? "，还有更早的" : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => void load().then((ok) => ok && toast.success("已刷新"))}
              disabled={loading}
            >
              <RefreshCw className={cn("size-[15px]", loading && "animate-spin")} />
              刷新
            </Button>
          </div>

          <section
            aria-label="运行列表"
            className="overflow-hidden rounded-2xl border border-border bg-card"
          >
            {error ? (
              <EmptyState
                title="运行记录没有载入"
                action={
                  <Button variant="outline" onClick={() => void load()}>
                    <RefreshCw />
                    重试
                  </Button>
                }
              >
                {error}
              </EmptyState>
            ) : loading && items.length === 0 ? (
              <div className="space-y-3 p-5" aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
                <p className="text-center text-sm text-muted-foreground">正在载入运行记录…</p>
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                title="没有符合条件的运行"
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAgentId("");
                        setStatus("");
                        setSource("");
                        setAccountId("");
                      }}
                    >
                      清除筛选
                    </Button>
                  ) : undefined
                }
              >
                {filtered ? "换个筛选条件试试。" : "去对话里用一次智能体，运行就会出现在这里。"}
              </EmptyState>
            ) : (
              <>
                {/* 窄屏:卡片列表,状态与花费不会被挤到屏幕外 */}
                <ul className="divide-y divide-line-soft sm:hidden" aria-label="运行列表">
                  {items.map((r) => {
                    const credits = runCreditsText(r.credits);
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full flex-col gap-1.5 px-4 py-3 text-left",
                            detail?.id === r.id && "bg-accent",
                          )}
                          onClick={() => void openDetail(r.id)}
                        >
                          <span className="flex w-full items-center gap-2">
                            <AgentAvatar
                              id={r.agentId}
                              icon={agentById.get(r.agentId)?.icon}
                              size={24}
                            />
                            <span className="min-w-0 flex-1 truncate font-semibold">
                              {r.agentName ?? r.agentId}
                            </span>
                            <StatusBadge status={r.status} />
                          </span>
                          <span className="line-clamp-2 text-sm">{r.promptPreview}</span>
                          <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                            <span className="tabular-nums">{shortTime(r.createdAt)}</span>
                            <span>{SOURCE_LABEL[r.source]}</span>
                            {platform && r.account && (
                              <span className="max-w-full truncate">
                                {r.account.email ?? r.account.id}
                              </span>
                            )}
                            {credits && <span className="tabular-nums">{credits}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className={cn(tb.wrap, "max-sm:hidden")}>
                  <table className={cn(tb.table, platform ? "min-w-[1040px]" : "min-w-[880px]")}>
                    <caption className="sr-only">运行列表,按回车查看详情</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={cn(tb.th, tb.first)}>
                          时间
                        </th>
                        {platform && (
                          <th scope="col" className={tb.th}>
                            账号
                          </th>
                        )}
                        <th scope="col" className={tb.th}>
                          智能体
                        </th>
                        <th scope="col" className={tb.th}>
                          来源
                        </th>
                        <th scope="col" className={tb.th}>
                          状态
                        </th>
                        <th scope="col" className={tb.th}>
                          输入
                        </th>
                        <th scope="col" className={tb.th}>
                          耗时
                        </th>
                        <th scope="col" className={cn(tb.th, tb.last, tb.right)}>
                          花费
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r) => {
                        const tokens = tokensText(r.cost);
                        const credits = runCreditsText(r.credits);
                        return (
                          <tr
                            key={r.id}
                            tabIndex={0}
                            className={cn(tb.clickRow, detail?.id === r.id && tb.selRow)}
                            onClick={() => void openDetail(r.id)}
                            onKeyDown={(e) => e.key === "Enter" && void openDetail(r.id)}
                          >
                            <td className={cn(tb.td, tb.first, tb.num)}>
                              <span title={formatTime(r.createdAt)}>{shortTime(r.createdAt)}</span>
                            </td>
                            {platform && (
                              <td className={tb.td}>
                                <span
                                  className="block max-w-48 truncate"
                                  title={r.account?.email ?? r.account?.id}
                                >
                                  {r.account?.email ?? r.account?.id ?? (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </span>
                              </td>
                            )}
                            <td className={tb.td}>
                              <span className="flex items-center gap-2 whitespace-nowrap">
                                <AgentAvatar
                                  id={r.agentId}
                                  icon={agentById.get(r.agentId)?.icon}
                                  size={24}
                                />
                                <span className="max-w-40 truncate">
                                  {r.agentName ?? r.agentId}
                                </span>
                                <VersionBadge version={r.agentVersion} />
                              </span>
                            </td>
                            <td className={cn(tb.td, "whitespace-nowrap")}>
                              {SOURCE_LABEL[r.source]}
                            </td>
                            <td className={tb.td}>
                              <StatusBadge status={r.status} />
                            </td>
                            <td className={tb.td}>
                              <div
                                className={cn(
                                  "max-w-[300px] truncate",
                                  looksLikeJson(r.promptPreview) && "font-mono text-[13px]",
                                )}
                                title={r.promptPreview}
                              >
                                {r.promptPreview}
                              </div>
                            </td>
                            <td className={cn(tb.td, tb.num)}>{formatDuration(r.durationMs)}</td>
                            <td className={cn(tb.td, tb.last, tb.num, tb.right)}>
                              {tokens || credits ? (
                                <>
                                  {tokens}
                                  {r.cost?.partial && (
                                    <Badge
                                      variant="warning"
                                      className="ml-1"
                                      title="有模型调用没回报用量,统计不完整"
                                    >
                                      部分
                                    </Badge>
                                  )}
                                  {credits && (
                                    <div className="text-xs text-muted-foreground">{credits}</div>
                                  )}
                                </>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!error && items.length > 0 && (
              <div className="flex items-center justify-center gap-2.5 p-3.5">
                {cursor ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void load(cursor)}
                  >
                    {loading ? "载入中…" : "加载更多"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">没有更早的运行了</span>
                )}
              </div>
            )}
          </section>
        </>
      )}

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-[520px]">
          {detail && (
            <>
              <div className="flex items-center gap-3 border-b border-line-soft px-[22px] py-[18px]">
                <AgentAvatar id={detail.agentId} icon={detailAgent?.icon} size={36} />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
                    <span className="truncate">{detail.agentName ?? detail.agentId}</span>
                    <VersionBadge version={detail.agentVersion} />
                  </SheetTitle>
                  <SheetDescription className="text-xs">
                    {platform && detail.account
                      ? `${detail.account.email ?? detail.account.id}，`
                      : ""}
                    {formatTime(detail.createdAt)}，{SOURCE_LABEL[detail.source]}，
                    {formatDuration(detail.durationMs)}
                  </SheetDescription>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="关闭"
                  className="max-md:size-11"
                  onClick={() => setDetail(null)}
                >
                  <X />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-[18px] text-sm">
                <div className="mb-3.5 flex flex-wrap items-center gap-2">
                  <StatusBadge status={detail.status} />
                  <span className="text-xs text-muted-foreground">
                    {tokensText(detail.cost) ?? "没有用量记录"}
                    {runCreditsText(detail.credits) ? `，${runCreditsText(detail.credits)}` : ""}
                    {detail.cost?.partial ? "（部分，统计不完整）" : ""}
                  </span>
                  {canCancelRun(detail.status) && (
                    <Button
                      size="sm"
                      variant="destructive"
                      className="ml-auto"
                      disabled={cancelling}
                      onClick={() =>
                        confirm.ask({
                          title: "取消这次运行？",
                          description:
                            detail.status === "pending"
                              ? `「${detail.agentName ?? detail.agentId}」会立即停止，排队中的运行不会产生费用。`
                              : `「${detail.agentName ?? detail.agentId}」会立即停止，已经消耗的 tokens 照常计费，冻结的多余积分会退回。`,
                          confirmLabel: "取消运行",
                          destructive: true,
                          onConfirm: () => cancelRun(detail),
                        })
                      }
                    >
                      <Square className="size-3.5" />
                      {cancelling ? "取消中…" : "取消运行"}
                    </Button>
                  )}
                </div>
                <DetailSection title="输入">
                  {looksLikeJson(detail.prompt) ? (
                    <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px]">
                      {prettyInput(detail.prompt)}
                    </pre>
                  ) : (
                    <p className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                      {detail.prompt}
                    </p>
                  )}
                </DetailSection>
                {detail.error?.message && (
                  <DetailSection title="错误">
                    <div className="mt-1.5 rounded-xl border border-[#EBC5BB] bg-destructive-soft px-3 py-2.5 text-[#8F3423]">
                      {detail.error.kind && (
                        <div className="mb-0.5 font-mono text-xs">kind: {detail.error.kind}</div>
                      )}
                      {detail.error.message}
                    </div>
                  </DetailSection>
                )}
                {detail.structured !== undefined && (
                  <DetailSection title="结构化结果">
                    <pre className="mt-1.5 max-h-72 overflow-auto rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px]">
                      {JSON.stringify(detail.structured, null, 2)}
                    </pre>
                  </DetailSection>
                )}
                {detail.finalText ? (
                  <DetailSection title="最终回答">
                    <div className="mt-1">
                      <MessageResponse>{detail.finalText}</MessageResponse>
                    </div>
                  </DetailSection>
                ) : canCancelRun(detail.status) ? (
                  <DetailSection title="最终回答">
                    <p className="mt-1 text-muted-foreground">
                      {detail.status === "pending" ? "还在排队，" : ""}运行结束后显示。
                    </p>
                  </DetailSection>
                ) : detail.status === "cancelled" ? (
                  <DetailSection title="最终回答">
                    <p className="mt-1 text-muted-foreground">
                      运行在完成前被取消，没有最终回答。已消耗的 tokens 照常计费。
                    </p>
                  </DetailSection>
                ) : null}
                <DetailSection>
                  <dl className="grid grid-cols-[84px_1fr] items-center gap-x-3 gap-y-1.5">
                    <dt className="text-muted-foreground">taskId</dt>
                    <dd className="flex min-w-0 items-center gap-1 font-mono text-[13px] break-all">
                      {detail.id}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="复制 taskId"
                        onClick={() => void copy(detail.id)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </dd>
                    <dt className="text-muted-foreground">会话</dt>
                    <dd className="font-mono text-[13px] break-all">{detail.sessionId}</dd>
                  </dl>
                </DetailSection>
                {platform && detail.account && (
                  <DetailSection title="账号">
                    <p className="mt-1 break-all">{detail.account.email ?? detail.account.id}</p>
                  </DetailSection>
                )}
                {!hasChatTranscript(detail.source) ? (
                  <p className="text-xs text-muted-foreground">
                    接口调用和评测不产生可查看的对话；完整过程可用{" "}
                    <code className="font-mono">GET /api/sessions/{"{id}"}/events</code>{" "}
                    读取事件流。
                  </p>
                ) : platform && detail.canOpenSession === false ? (
                  // 平台运行:别人的会话是私有的,管理员也打不开 —— 按钮留着但禁用,说明原因
                  <div className="space-y-1.5">
                    <Button variant="outline" className="w-full" disabled>
                      <MessageSquare />
                      在对话里查看完整过程
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      会话是私有的，管理员也不能查看别人的对话过程。
                      {detail.account?.email
                        ? `需要排查时，请联系 ${detail.account.email} 本人分享。`
                        : ""}
                    </p>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full" asChild>
                    <a
                      href={`/chat?session=${encodeURIComponent(detail.sessionId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MessageSquare />
                      在对话里查看完整过程
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      {confirm.dialog}
    </>
  );
}

function DetailSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 rounded-[14px] border border-border px-4 py-3.5">
      {title && <h3 className="text-sm font-semibold">{title}</h3>}
      {children}
    </section>
  );
}
