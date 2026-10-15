"use client";

import { SpaceShell } from "@/components/space-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { isAdminView, useMe } from "@/lib/use-me";
import { Bot, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { MarketActions } from "./market-actions";

export function MarketView() {
  const { me } = useMe();
  const admin = isAdminView(me);
  const [manage, setManage] = useState(false);
  const [items, setItems] = useState<MarketAgent[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((v) => v + 1), []);
  const managing = manage && admin;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh retries the current query.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchJson<{ items: MarketAgent[] }>(`/api/market${managing ? "?manage=true" : ""}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setItems(data.items);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [managing, refresh]);

  const term = search.trim().toLocaleLowerCase();
  const visible = items.filter(
    (item) =>
      (!category || item.category === category) &&
      (!term || `${item.name}\n${item.description ?? ""}`.toLocaleLowerCase().includes(term)),
  );

  return (
    <SpaceShell
      area="market"
      title="智能体市场"
      actions={
        <Button
          variant="ghost"
          size="icon"
          title="刷新市场"
          aria-label="刷新市场"
          onClick={reload}
          disabled={loading}
        >
          <RefreshCw className="size-4" />
        </Button>
      }
    >
      {admin && (
        <Tabs
          value={managing ? "manage" : "browse"}
          onValueChange={(value) => setManage(value === "manage")}
        >
          <TabsList>
            <TabsTrigger value="browse">浏览市场</TabsTrigger>
            <TabsTrigger value="manage">上下架管理</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="搜索智能体"
            placeholder="搜索名称或说明"
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <NativeSelect
          className="sm:w-44"
          aria-label="智能体类别"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">全部类别</option>
          {MARKET_CATEGORIES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {loading ? (
        <p className="py-8 text-sm text-muted-foreground">正在加载…</p>
      ) : error ? (
        <Alert>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            <Button variant="outline" onClick={reload}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : visible.length === 0 ? (
        <div className="space-y-3 py-8 text-sm text-muted-foreground">
          <p>
            {search || category
              ? "没有符合条件的智能体"
              : managing
                ? "暂无已发布智能体"
                : "暂无上架智能体"}
          </p>
          {managing && (
            <Link href="/agents" className="text-primary underline underline-offset-4">
              前往我的智能体
            </Link>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {visible.map((item) => (
            <li key={item.id} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Bot className="size-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 space-y-2">
                  <h2 className="break-words text-sm font-semibold">
                    {item.marketListed ? (
                      <Link
                        className="hover:underline"
                        href={`/market/${encodeURIComponent(item.id)}`}
                      >
                        {item.name}
                      </Link>
                    ) : (
                      item.name
                    )}
                  </h2>
                  <p className="break-words text-sm text-muted-foreground">
                    {item.description || "暂无说明"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {MARKET_CATEGORIES.find((c) => c.id === item.category)?.name ?? "通用助手"}
                    {" · "}v{item.publishedVersion}
                    {" · "}
                    {item.config.model}
                    {managing ? ` · ${item.marketListed ? "已上架" : "未上架"}` : ""}
                  </p>
                </div>
              </div>
              {managing ? (
                <ListingControls item={item} onSaved={reload} />
              ) : (
                <MarketActions agentId={item.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </SpaceShell>
  );
}

function ListingControls({ item, onSaved }: { item: MarketAgent; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);

  async function save(listed: boolean, category: string) {
    if (busy) return;
    if (item.marketListed && !listed && !window.confirm(`下架「${item.name}」？`)) return;
    setBusy(true);
    try {
      await fetchJson(`/api/market/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listed, category }),
      });
      toast.success(item.marketListed === listed ? "已更新类别" : listed ? "已上架" : "已下架");
      onSaved();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={`${item.name}的类别`}
        value={item.category}
        disabled={busy}
        className="w-36"
        onChange={(event) => void save(item.marketListed, event.target.value)}
      >
        {MARKET_CATEGORIES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </NativeSelect>
      <Button
        size="sm"
        variant={item.marketListed ? "outline" : "default"}
        disabled={busy}
        onClick={() => void save(!item.marketListed, item.category)}
      >
        {busy ? "保存中…" : item.marketListed ? "下架" : "上架"}
      </Button>
    </div>
  );
}
