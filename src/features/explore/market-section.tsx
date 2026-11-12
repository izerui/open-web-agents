"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketActions } from "@/features/market/market-actions";
import { ModelPrice } from "@/features/models/model-price";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { formatPerRun, formatUseCount } from "@/lib/modules/market/domain/display";
import { Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type MarketSort, designerHref, filterMarket, sortMarket } from "./explore-logic";

/** 窄屏上分段按钮加高到 44px,手指点得准 */
const TRIGGER = "max-md:h-11!";
const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
const CATEGORY_NAME = new Map<string, string>(MARKET_CATEGORIES.map((c) => [c.id, c.name]));

function dateText(ms: number | null): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 市场区:分类、搜索、排序、刷新与卡片网格;加载 / 失败 / 无匹配 / 暂无上架四种状态。 */
export function MarketSection() {
  const [items, setItems] = useState<MarketAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<MarketSort>("hot");

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 只用来重试与刷新
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchJson<{ items: MarketAgent[] }>("/api/market", { signal: controller.signal })
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
  }, [refresh]);

  const reload = () => setRefresh((v) => v + 1);
  const visible = sortMarket(filterMarket(items, { category, search }), sort);
  const q = search.trim();

  return (
    <section
      className="px-20 pt-12 pb-16 max-lg:px-8 max-md:px-5 max-md:pt-9"
      aria-labelledby="market-title"
    >
      <h2 id="market-title" className="font-display text-4xl font-bold max-md:text-[28px]">
        招募你的 AI 同事
      </h2>
      <p className="mt-1.5 text-base text-muted-foreground">
        管理员上架的智能体，点开就能聊，也可以克隆一份改成自己的，或者用 API 接进你的系统。
      </p>

      <div className="mt-5 mb-[22px] flex flex-wrap items-center gap-2.5">
        <Tabs
          value={category || "all"}
          onValueChange={(v) => setCategory(v === "all" ? "" : v)}
          className="max-w-full min-w-0"
        >
          <TabsList
            variant="segment"
            aria-label="分类"
            className="max-w-full justify-start overflow-x-auto [scrollbar-width:none]"
          >
            <TabsTrigger value="all" className={TRIGGER}>
              全部
            </TabsTrigger>
            {MARKET_CATEGORIES.map((c) => (
              <TabsTrigger key={c.id} value={c.id} className={TRIGGER}>
                {c.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-sm text-muted-foreground">
          已上架{" "}
          <b className="font-semibold text-foreground">{loading || error ? "—" : items.length}</b>{" "}
          个
        </span>
        <div className="relative ml-auto w-[260px] max-md:order-last max-md:ml-0 max-md:w-full">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="搜索名称或说明"
            placeholder="搜索名称或说明"
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-full pl-[38px] max-md:h-11"
          />
        </div>
        <Tabs value={sort} onValueChange={(v) => setSort(v as MarketSort)}>
          <TabsList variant="segment" aria-label="排序">
            <TabsTrigger value="hot" className={TRIGGER}>
              最常用
            </TabsTrigger>
            <TabsTrigger value="new" className={TRIGGER}>
              最新
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="icon"
          title="刷新"
          aria-label="刷新市场"
          disabled={loading}
          onClick={reload}
          className="max-md:size-11"
        >
          <RefreshCw />
        </Button>
      </div>

      {loading ? (
        <>
          <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-4 animate-spin rounded-full border-2 border-[#D9D5CB] border-t-foreground" />
            正在加载…
          </p>
          <div className="grid grid-cols-4 gap-4 max-xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
            {SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="flex flex-col gap-3 rounded-[18px] border border-border bg-card p-5"
              >
                <div className="flex items-center gap-3">
                  <div className="size-12 animate-pulse rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-3/5 animate-pulse rounded-lg bg-muted" />
                    <div className="h-3 w-2/5 animate-pulse rounded-lg bg-muted" />
                  </div>
                </div>
                <div className="h-3.5 animate-pulse rounded-lg bg-muted" />
                <div className="h-3.5 w-4/5 animate-pulse rounded-lg bg-muted" />
                <div className="h-[22px] w-3/4 animate-pulse rounded-lg bg-muted" />
              </div>
            ))}
          </div>
        </>
      ) : error ? (
        <StateCard title="市场加载失败" text={`${error}。你的会话和智能体不受影响。`}>
          <Button onClick={reload} className="max-md:h-11">
            <RefreshCw />
            重试
          </Button>
        </StateCard>
      ) : items.length === 0 ? (
        <StateCard
          title="暂无上架智能体"
          text="管理员还没有把智能体上架到市场。你可以先自己做一个。"
        >
          <Button asChild className="max-md:h-11">
            <Link href="/agents">前往我的智能体</Link>
          </Button>
          <Button variant="outline" asChild className="max-md:h-11">
            <Link href="/agents/new">
              <Plus />
              新建智能体
            </Link>
          </Button>
        </StateCard>
      ) : visible.length === 0 ? (
        <StateCard
          title="没有符合条件的智能体"
          text={`${q ? `「${q}」` : ""}${category ? `在「${CATEGORY_NAME.get(category)}」分类下` : ""}没有找到。换个关键词，或者让智能体设计器做一个。`}
        >
          <Button
            variant="outline"
            className="max-md:h-11"
            onClick={() => {
              setSearch("");
              setCategory("");
            }}
          >
            清除筛选
          </Button>
          <Button asChild className="max-md:h-11">
            <Link href={designerHref(q ? `做一个${q}助手` : "")}>
              <Sparkles />
              让智能体设计器做一个
            </Link>
          </Button>
        </StateCard>
      ) : (
        <ul className="grid grid-cols-4 gap-4 max-xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {visible.map((item) => (
            <MarketCard key={item.id} item={item} sort={sort} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StateCard({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[18px] border border-border bg-card px-6 py-12 text-center">
      <p className="mb-1.5 font-display text-[22px] font-bold">{title}</p>
      <p className="mb-[18px] text-[15px] text-muted-foreground">{text}</p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

function MarketCard({ item, sort }: { item: MarketAgent; sort: MarketSort }) {
  const router = useRouter();
  const href = `/market/${encodeURIComponent(item.id)}`;
  const price = formatPerRun(item.avgCredits);
  const published = dateText(item.publishedAt);
  return (
    // 整张卡可点进详情;卡里的按钮与链接各管各的
    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户经名称链接进入详情
    <li
      className="flex cursor-pointer flex-col gap-2.5 rounded-[18px] border border-border bg-card p-5 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgb(60_50_30/8%)]"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,[role=dialog]")) return;
        router.push(href);
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AgentAvatar id={item.id} icon={item.icon} size={48} />
        <div className="min-w-0">
          <h3 className="font-display text-lg leading-tight font-bold break-words">
            <Link href={href} className="hover:underline">
              {item.name}
            </Link>
          </h3>
          {item.author && <p className="truncate text-xs text-muted-foreground">{item.author}</p>}
        </div>
      </div>
      <p className="line-clamp-2 min-h-[44px] text-sm break-words text-[#4A4740]">
        {item.description || "暂无说明"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{CATEGORY_NAME.get(item.category) ?? "通用助手"}</Badge>
        <Badge variant="outline">v{item.publishedVersion}</Badge>
        {price && <Badge variant="outline">{price}</Badge>}
        <Badge variant="outline">
          {sort === "new" && published ? `${published} 发布` : formatUseCount(item.useCount)}
        </Badge>
      </div>
      {!price && (
        <p className="text-xs text-muted-foreground">
          <ModelPrice model={item.config.model} />
        </p>
      )}
      <div className="mt-auto pt-1">
        <MarketActions agentId={item.id} name={item.name} version={item.publishedVersion} />
      </div>
    </li>
  );
}
