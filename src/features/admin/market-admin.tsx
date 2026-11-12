"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { useConfirm } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import type { ListingRequest } from "@/lib/modules/market/listing-request-ports";
import { cn } from "@/lib/utils";
import { Check, ExternalLink, Info, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AdminPage,
  AdminTabs,
  EmptyState,
  Segmented,
  TD,
  TH,
  TableCard,
  useTabParam,
} from "./admin-ui";

type ManagedAgent = MarketAgent & {
  ownerEmail?: string;
  isPublic: boolean;
  pendingRequestId?: string;
};

/** 还没发布的智能体:列出来但不能上架 */
type UnpublishedAgent = {
  id: string;
  name: string;
  icon?: string;
  ownerEmail?: string;
  isPublic: boolean;
};

type RequestRow = ListingRequest & {
  agentName: string;
  agentIcon?: string;
  agentDescription?: string;
  requesterEmail?: string;
  ownerEmail?: string;
  publishedVersion?: number;
  marketListed: boolean;
  isPublic?: boolean;
  /** 智能体当前的市场类别;没有为 null */
  agentCategory?: string | null;
  deleted: boolean;
  evalState?: string;
  evalPassed?: number;
  evalTotal?: number;
};

const TABS = ["agents", "requests"] as const;
type Tab = (typeof TABS)[number];

const LISTED_FILTERS = [
  { value: "all", label: "全部" },
  { value: "listed", label: "已上架" },
  { value: "unlisted", label: "未上架" },
] as const;
type ListedFilter = (typeof LISTED_FILTERS)[number]["value"];

const REQUEST_FILTERS = [
  { value: "pending", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已驳回" },
  { value: "all", label: "全部" },
] as const;
type RequestFilter = (typeof REQUEST_FILTERS)[number]["value"];

const categoryName = (id?: string) =>
  MARKET_CATEGORIES.find((c) => c.id === id)?.name ?? "通用助手";

const when = (ms: number) => formatTime(ms);

/** 评测结论的一句话（只对待审申请计算；没有就不显示） */
function evalBadge(r: RequestRow) {
  switch (r.evalState) {
    case "passed":
      return (
        <Badge variant="success">
          评测已通过 {r.evalPassed}/{r.evalTotal}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          评测未通过 {r.evalPassed}/{r.evalTotal}
        </Badge>
      );
    case "running":
      return <Badge variant="warning">评测进行中</Badge>;
    case "cases_changed":
      return <Badge variant="warning">用例改过，需重新评测</Badge>;
    case "none":
      return <Badge variant="warning">发布版未评测</Badge>;
    case "no_cases":
      return <Badge variant="warning">没有评测用例</Badge>;
    default:
      return null;
  }
}

/**
 * 平台管理 · 市场上架（原 /admin/market）+「上架申请」审核队列（A13）。
 * 公开 ≠ 上架：公开只是所有账号只读可见，上架才出现在探索页。
 */
export function MarketAdmin() {
  const [tab, setTab] = useTabParam<Tab>(TABS, "agents");
  const [items, setItems] = useState<ManagedAgent[]>([]);
  const [unpublished, setUnpublished] = useState<UnpublishedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [pendingCount, setPendingCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ items: ManagedAgent[]; unpublished?: UnpublishedAgent[] }>(
        "/api/admin/market/agents",
      );
      setItems(d.items);
      setUnpublished(d.unpublished ?? []);
      setPendingCount(d.items.filter((i) => i.pendingRequestId).length);
      setError("");
      setLoaded(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const listed = items.filter((i) => i.marketListed).length;

  return (
    <AdminPage
      title="市场上架"
      subtitle={`${loaded ? `${listed} 个已上架，${items.length - listed} 个已发布未上架。` : ""}公开只是对所有账号只读可见，上架才会出现在探索页`}
      actions={
        <Button asChild variant="outline">
          <Link href="/" target="_blank">
            <ExternalLink />
            查看探索页
          </Link>
        </Button>
      }
      tabs={
        <AdminTabs
          label="市场上架"
          value={tab}
          onChange={setTab}
          items={[
            { value: "agents", label: "智能体" },
            {
              value: "requests",
              label: "上架申请",
              badge: pendingCount ? <Badge variant="warning">{pendingCount}</Badge> : undefined,
            },
          ]}
        />
      }
    >
      {tab === "agents" ? (
        <AgentsTab
          items={items}
          unpublished={unpublished}
          loading={loading}
          loaded={loaded}
          error={error}
          reload={load}
        />
      ) : (
        <RequestsTab onChanged={load} />
      )}
    </AdminPage>
  );
}

function AgentsTab({
  items,
  unpublished,
  loading,
  loaded,
  error,
  reload,
}: {
  items: ManagedAgent[];
  unpublished: UnpublishedAgent[];
  loading: boolean;
  loaded: boolean;
  error: string;
  reload: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [listed, setListed] = useState<ListedFilter>("all");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();

  async function save(item: ManagedAgent, nextListed: boolean, nextCategory: string) {
    if (busy) return;
    setBusy(item.id);
    try {
      await fetchJson(`/api/market/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listed: nextListed, category: nextCategory }),
      });
      toast.success(
        item.marketListed === nextListed
          ? `「${item.name}」类别改为${categoryName(nextCategory)}`
          : nextListed
            ? `「${item.name}」v${item.publishedVersion} 已上架到${categoryName(nextCategory)}`
            : `「${item.name}」已下架`,
      );
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const term = search.trim().toLocaleLowerCase();
  const visible = items.filter(
    (i) =>
      (!term ||
        `${i.name}\n${i.id}\n${i.ownerEmail ?? ""}\n${i.description ?? ""}`
          .toLocaleLowerCase()
          .includes(term)) &&
      (listed === "all" || (listed === "listed") === i.marketListed) &&
      (!category || i.category === category),
  );
  // 未发布的只在「全部 / 未上架」且不按类别筛时列出(它们还没有类别)
  const drafts =
    listed === "listed" || category
      ? []
      : unpublished.filter(
          (i) =>
            !term || `${i.name}\n${i.id}\n${i.ownerEmail ?? ""}`.toLocaleLowerCase().includes(term),
        );

  return (
    <>
      {confirm.dialog}
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <label className="relative w-[280px] max-w-full">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            type="search"
            maxLength={200}
            placeholder="搜索名称、标识或所有者"
            aria-label="搜索智能体"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Segmented
          label="按上架状态筛选"
          items={LISTED_FILTERS}
          value={listed}
          onChange={setListed}
        />
        <NativeSelect
          className="w-[150px]"
          aria-label="按类别筛选"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类别</option>
          {MARKET_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void reload()}
          aria-label="刷新列表"
        >
          <RefreshCw className={cn(loading && "animate-spin")} />
          刷新
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          显示 {visible.length + drafts.length} 个
        </span>
      </div>
      <TableCard>
        {error && !loaded ? (
          <LoadError what="已发布智能体" message={error} onRetryAction={() => void reload()} />
        ) : !loaded ? (
          <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在加载…
          </div>
        ) : items.length === 0 && drafts.length === 0 ? (
          <EmptyState
            title="还没有已发布的智能体"
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/agents">前往我的智能体</Link>
              </Button>
            }
          >
            智能体发布后才能上架到市场。
          </EmptyState>
        ) : visible.length === 0 && drafts.length === 0 ? (
          <EmptyState
            title="没有符合条件的智能体"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setListed("all");
                  setCategory("");
                }}
              >
                清除筛选
              </Button>
            }
          >
            换个关键词，或把状态和类别切回「全部」。
          </EmptyState>
        ) : (
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <caption className="sr-only">已发布智能体与上架状态</caption>
            <thead>
              <tr>
                {["智能体", "所有者", "发布版", "公开", "类别", "状态"].map((h) => (
                  <th key={h} scope="col" className={TH}>
                    {h}
                  </th>
                ))}
                <th scope="col" className={cn(TH, "text-right")}>
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td className={TD}>
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar id={item.id} icon={item.icon} size={30} />
                      <div className="min-w-0">
                        <div className="font-semibold break-words">
                          {item.marketListed ? (
                            <Link
                              href={`/market/${encodeURIComponent(item.id)}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {item.name}
                            </Link>
                          ) : (
                            item.name
                          )}
                        </div>
                        <div className="font-mono text-xs break-all text-muted-foreground">
                          {item.id}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, "break-all")}>
                    {item.ownerEmail ?? <span className="text-muted-foreground">平台内置</span>}
                  </td>
                  <td className={TD}>v{item.publishedVersion}</td>
                  <td className={TD}>
                    {item.isPublic ? (
                      <Badge variant="outline">已公开</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">仅授权可见</span>
                    )}
                  </td>
                  <td className={TD}>
                    <NativeSelect
                      aria-label={`${item.name}的类别`}
                      className="w-[132px]"
                      value={item.category}
                      disabled={busy !== null}
                      onChange={(e) => void save(item, item.marketListed, e.target.value)}
                    >
                      {MARKET_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-wrap gap-1">
                      {item.marketListed ? (
                        <Badge variant="success">已上架</Badge>
                      ) : (
                        <Badge>未上架</Badge>
                      )}
                      {item.pendingRequestId && <Badge variant="warning">有待审申请</Badge>}
                    </div>
                  </td>
                  <td className={cn(TD, "text-right")}>
                    {item.marketListed ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy !== null}
                        onClick={() =>
                          confirm.ask({
                            title: `下架「${item.name}」?`,
                            description:
                              "下架后探索页不再展示，用户也不能再从市场「立即使用」或克隆。已经在用的会话、已签发的 API Key 和所有者自己的使用不受影响；「公开」设置保持不变。",
                            confirmLabel: "下架",
                            destructive: true,
                            onConfirm: () => save(item, false, item.category),
                          })
                        }
                      >
                        {busy === item.id ? "保存中…" : "下架"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void save(item, true, item.category)}
                      >
                        {busy === item.id ? "保存中…" : "上架"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {drafts.map((item) => (
                <tr key={item.id} className="text-muted-foreground">
                  <td className={TD}>
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar id={item.id} icon={item.icon} size={30} />
                      <div className="min-w-0">
                        <div className="font-semibold break-words text-foreground">{item.name}</div>
                        <div className="font-mono text-xs break-all">{item.id}</div>
                      </div>
                    </div>
                  </td>
                  <td className={cn(TD, "break-all")}>{item.ownerEmail ?? "—"}</td>
                  <td className={TD}>未发布</td>
                  <td className={TD}>
                    {item.isPublic ? (
                      <Badge variant="outline">已公开</Badge>
                    ) : (
                      <span className="text-xs">仅授权可见</span>
                    )}
                  </td>
                  <td className={TD}>—</td>
                  <td className={TD}>
                    <Badge variant="warning">未发布</Badge>
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <span className="inline-flex flex-col items-end gap-1">
                      <Button size="sm" disabled title="先发布才能上架">
                        上架
                      </Button>
                      <span className="text-xs">先发布才能上架</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
    </>
  );
}

function RequestsTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<RequestFilter>("pending");
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RequestRow | null>(null);
  /** 审核时预览上架后的详情页(还没上架,市场详情页打不开) */
  const [previewing, setPreviewing] = useState<RequestRow | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = status === "all" ? "" : `?status=${status}`;
      const d = await fetchJson<{ requests: RequestRow[] }>(`/api/admin/market/requests${q}`);
      setRows(d.requests);
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  async function decide(r: RequestRow, body: Record<string, unknown>, ok: string) {
    setBusy(r.id);
    try {
      await fetchJson(`/api/admin/market/requests/${encodeURIComponent(r.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success(ok);
      setRejecting(null);
      await Promise.all([load(), onChanged()]);
      return true;
    } catch (err) {
      toast.error(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {confirm.dialog}
      <p className="mb-3.5 flex items-start gap-2.5 rounded-[14px] bg-band px-4 py-3 text-sm text-[#3C3A35]">
        <Info className="mt-0.5 size-4 shrink-0" />
        所有者在构建页「发布」阶段提交申请。通过后按所选类别上架到探索页；驳回时写明原因，所有者在构建页看得到，可以修改后重新申请。
      </p>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <Segmented
          label="按申请状态筛选"
          items={REQUEST_FILTERS}
          value={status}
          onChange={setStatus}
        />
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          刷新
        </Button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {error ? (
          <LoadError what="上架申请" message={error} onRetryAction={() => void load()} />
        ) : rows === null ? (
          <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在加载…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={status === "pending" ? "没有待审核的申请" : "没有申请记录"}>
            所有者在构建页「发布」阶段申请上架后，会出现在这里。
          </EmptyState>
        ) : (
          <ul>
            {rows.map((r) => {
              const category = categories[r.id] ?? r.agentCategory ?? "general";
              return (
                <li
                  key={r.id}
                  className="grid gap-4 border-t border-line-soft px-5 py-[18px] first:border-t-0 md:grid-cols-[minmax(0,1fr)_260px]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar id={r.agentId} icon={r.agentIcon} size={36} />
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold break-words">
                          {r.agentName}{" "}
                          <span className="font-normal text-muted-foreground">v{r.version}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.requesterEmail ?? r.requesterId} 申请于 {when(r.createdAt)}
                          {r.ownerEmail && r.ownerEmail !== r.requesterEmail
                            ? `，所有者 ${r.ownerEmail}`
                            : ""}
                        </div>
                      </div>
                    </div>
                    {r.note ? (
                      <p className="mt-2.5 rounded-xl bg-band px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap">
                        {r.note}
                      </p>
                    ) : (
                      <p className="mt-2.5 text-sm text-muted-foreground">没有填写申请说明。</p>
                    )}
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">
                        类别：{r.agentCategory ? categoryName(r.agentCategory) : "未选"}
                      </Badge>
                      <Badge variant="outline">{r.isPublic ? "已公开" : "未公开"}</Badge>
                      {r.publishedVersion !== undefined && r.publishedVersion !== r.version && (
                        <Badge variant="outline">当前发布版已是 v{r.publishedVersion}</Badge>
                      )}
                      {r.marketListed && <Badge variant="success">已在市场上</Badge>}
                      {r.deleted && <Badge variant="destructive">智能体已删除</Badge>}
                      {evalBadge(r)}
                      {r.marketListed ? (
                        <Link
                          href={`/market/${encodeURIComponent(r.agentId)}`}
                          target="_blank"
                          className="ml-1 text-xs underline underline-offset-2"
                        >
                          预览详情页
                        </Link>
                      ) : (
                        !r.deleted && (
                          <button
                            type="button"
                            className="ml-1 min-h-8 text-xs underline underline-offset-2"
                            onClick={() => setPreviewing(r)}
                          >
                            预览详情页
                          </button>
                        )
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col justify-center gap-2">
                    {r.status === "pending" ? (
                      <>
                        <label className="grid gap-1.5 text-[13px] text-muted-foreground">
                          上架到类别
                          <NativeSelect
                            value={category}
                            onChange={(e) =>
                              setCategories((m) => ({ ...m, [r.id]: e.target.value }))
                            }
                          >
                            {MARKET_CATEGORIES.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="flex-1"
                            disabled={busy !== null || r.deleted}
                            onClick={() =>
                              confirm.ask({
                                title: `通过并上架「${r.agentName}」?`,
                                description: `上架到「${categoryName(category)}」。所有者之后发布新版本时，市场自动跟随新的发布版。`,
                                confirmLabel: "通过并上架",
                                onConfirm: async () => {
                                  await decide(
                                    r,
                                    { action: "approve", category },
                                    `已上架到${categoryName(category)}`,
                                  );
                                },
                              })
                            }
                          >
                            <Check className="size-3.5" />
                            通过并上架
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            disabled={busy !== null}
                            onClick={() => setRejecting(r)}
                          >
                            驳回
                          </Button>
                        </div>
                      </>
                    ) : r.status === "approved" ? (
                      <div className="space-y-1">
                        <Badge variant="success">
                          已通过，上架到「{categoryName(r.category)}」
                        </Badge>
                        {r.decidedAt && (
                          <p className="text-xs text-muted-foreground">
                            处理于 {when(r.decidedAt)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Badge variant="destructive">已驳回</Badge>
                        <p className="text-xs break-words text-muted-foreground">
                          原因：{r.reason}
                        </p>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {previewing && (
        <PreviewDialog
          row={previewing}
          category={categories[previewing.id] ?? previewing.agentCategory ?? "general"}
          onClose={() => setPreviewing(null)}
        />
      )}
      {rejecting && (
        <RejectDialog
          row={rejecting}
          busy={busy !== null}
          onClose={() => setRejecting(null)}
          onSubmit={(reason) => decide(rejecting, { action: "reject", reason }, "已驳回")}
        />
      )}
    </>
  );
}

/** 上架申请的详情页预览:按市场详情页的头部信息展示申请的发布版本,审核时就能看到用户会看到什么 */
function PreviewDialog({
  row,
  category,
  onClose,
}: {
  row: RequestRow;
  category: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>预览详情页</DialogTitle>
          <DialogDescription>
            通过后，探索页和市场详情页会这样展示「{row.agentName}」（发布版 v{row.version}）。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-2xl border border-border p-5">
          <div className="flex items-center gap-3">
            <AgentAvatar id={row.agentId} icon={row.agentIcon} size={52} />
            <div className="min-w-0">
              <div className="font-display text-xl font-semibold break-words">{row.agentName}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge variant="outline">{categoryName(category)}</Badge>
                <Badge variant="outline">v{row.version}</Badge>
                {row.ownerEmail && (
                  <span className="text-xs text-muted-foreground">{row.ownerEmail}</span>
                )}
              </div>
            </div>
          </div>
          <p className="mt-4 text-sm break-words whitespace-pre-wrap">
            {row.agentDescription || <span className="text-muted-foreground">没有填写简介。</span>}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  row,
  busy,
  onClose,
  onSubmit,
}: {
  row: RequestRow;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>驳回「{row.agentName}」的上架申请</DialogTitle>
          <DialogDescription>
            {`原因会显示给${row.requesterEmail ? ` ${row.requesterEmail} ` : "申请人"}，对方可以修改后重新申请。`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason.trim()) {
              setError("请填写驳回原因");
              return;
            }
            await onSubmit(reason.trim());
          }}
        >
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            <span>
              驳回原因 <span className="text-destructive">*</span>
            </span>
            <Textarea
              rows={3}
              autoFocus
              maxLength={500}
              placeholder="例如：说明里缺少使用范围，补充后再申请"
              value={reason}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setError("");
              }}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              驳回
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
