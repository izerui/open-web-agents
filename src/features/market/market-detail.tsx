"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { AppShell } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { modelOf, useModelCatalog } from "@/features/builder/model-select";
import { creditsText, perStandard } from "@/features/models/model-shared";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsBalance } from "@/lib/modules/billing/domain/credits-display";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { formatPerRun, formatUseCount } from "@/lib/modules/market/domain/display";
import { cn } from "@/lib/utils";
import { Braces, ChevronLeft, ChevronRight, Copy, MessageSquare, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MarketActions, useAgentActions } from "./market-actions";

const CATEGORY_NAME = new Map<string, string>(MARKET_CATEGORIES.map((c) => [c.id, c.name]));

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ok"; agent: MarketAgent };

function dateText(ms: number | null): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 智能体详情(原 /market/[id]):整页,左侧说明 / 示例问题 / 契约,右侧价格、版本与基本信息。 */
export function MarketDetail({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 只用来重试
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch(`/api/market/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (res) => {
        if (controller.signal.aborted) return;
        // 404 = 下架了或链接有误,与「加载失败、可以重试」分开说
        if (res.status === 404) return setState({ kind: "missing" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          return setState({ kind: "error", message: body?.error ?? `请求失败（${res.status}）` });
        }
        const body = (await res.json()) as { agent: MarketAgent };
        if (!controller.signal.aborted) setState({ kind: "ok", agent: body.agent });
      })
      .catch((err) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: errorText(err) });
      });
    return () => controller.abort();
  }, [id, refresh]);

  useEffect(() => {
    if (state.kind === "ok") document.title = `${state.agent.name}，智能体详情，Open Web Agents`;
  }, [state]);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1180px] px-10 pt-[22px] pb-16 max-md:px-5">
        <Link
          href="/"
          className="-ml-2 inline-flex h-[34px] items-center gap-1.5 rounded-full pr-3 pl-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground max-md:h-11"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          返回探索
        </Link>
        {state.kind === "loading" ? (
          <Skeleton />
        ) : state.kind === "missing" ? (
          <StateCard title="没有找到这个智能体" text="它可能已经下架，或者链接有误。">
            <Button asChild className="max-md:h-11">
              <Link href="/">回到探索</Link>
            </Button>
          </StateCard>
        ) : state.kind === "error" ? (
          <StateCard title="详情加载失败" text={state.message}>
            <Button variant="outline" asChild className="max-md:h-11">
              <Link href="/">回到探索</Link>
            </Button>
            <Button className="max-md:h-11" onClick={() => setRefresh((v) => v + 1)}>
              <RefreshCw />
              重试
            </Button>
          </StateCard>
        ) : (
          <Detail agent={state.agent} />
        )}
      </div>
    </AppShell>
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
    <div className="mt-6 rounded-[18px] border border-border bg-card px-6 py-14 text-center">
      <p className="mb-1.5 font-display text-[22px] font-bold">{title}</p>
      <p className="mb-[18px] text-[15px] text-muted-foreground">{text}</p>
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

function Skeleton() {
  const bar = "animate-pulse rounded-lg bg-muted";
  return (
    <div aria-busy="true">
      <div className="flex items-center gap-[26px] border-b border-border pt-[22px] pb-[30px]">
        <div className={cn(bar, "size-28 shrink-0 rounded-full max-md:size-[72px]")} />
        <div className="flex-1 space-y-3">
          <div className={cn(bar, "h-9 w-72 max-w-full")} />
          <div className={cn(bar, "h-4 w-52 max-w-full")} />
          <div className={cn(bar, "h-[22px] w-80 max-w-full")} />
        </div>
      </div>
      <p className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <span className="size-4 animate-spin rounded-full border-2 border-[#D9D5CB] border-t-foreground" />
        正在加载…
      </p>
    </div>
  );
}

function Detail({ agent }: { agent: MarketAgent }) {
  const { busy, start } = useAgentActions();
  const price = formatPerRun(agent.avgCredits);
  const published = dateText(agent.publishedAt);
  // 去重后当 key 用:重复的段落本来也没必要显示两遍
  const paragraphs = [...new Set((agent.description ?? "").split(/\n+/).filter((p) => p.trim()))];
  const category = CATEGORY_NAME.get(agent.category) ?? "通用助手";
  const starters = agent.config.starters ?? [];

  return (
    <>
      <div className="flex items-center gap-[26px] border-b border-border pt-[22px] pb-[30px] max-md:flex-col max-md:items-start max-md:gap-4">
        <AgentAvatar id={agent.id} icon={agent.icon} size={112} className="max-md:size-[72px]" />
        <div className="min-w-0 flex-1">
          <h1 className="mb-1.5 font-display text-[40px] leading-tight font-bold break-words max-md:text-[28px]">
            {agent.name}
          </h1>
          <p className="text-[15px] text-muted-foreground">
            {[
              agent.author ? `${agent.author} 发布` : null,
              published ? `v${agent.publishedVersion} 发布于 ${published}` : null,
            ]
              .filter(Boolean)
              .join("，") || `已发布 v${agent.publishedVersion}`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge>{category}</Badge>
            <Badge variant="success">已发布 v{agent.publishedVersion}</Badge>
            <Badge variant="outline">{formatUseCount(agent.useCount)}</Badge>
            {price && <Badge variant="outline">{price}</Badge>}
            {agent.config.outputSchema ? (
              <Badge variant="outline">
                <Braces className="size-3" aria-hidden="true" />
                有输出契约，可当接口调用
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="w-[220px] shrink-0 max-md:w-full">
          <MarketActions
            agentId={agent.id}
            name={agent.name}
            version={agent.publishedVersion}
            layout="stack"
          />
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-10 pt-[30px] max-lg:grid-cols-1">
        <div className="min-w-0">
          <section className="mb-[34px]">
            <h2 className="mb-3 font-display text-[22px] font-bold">它能做什么</h2>
            {paragraphs.length ? (
              paragraphs.map((p) => (
                <p
                  key={p}
                  className="mt-2.5 text-base leading-[1.8] break-words text-[#3C3A35] first:mt-0"
                >
                  {p}
                </p>
              ))
            ) : (
              <p className="text-base text-muted-foreground">作者没有写说明。</p>
            )}
          </section>

          {starters.length > 0 && (
            <section className="mb-[34px]">
              <h2 className="mb-3 font-display text-[22px] font-bold">试试这样问</h2>
              <ul className="space-y-2">
                {starters.map((text, index) => (
                  <li key={`${index}-${text}`}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void start(agent.id, { question: text })}
                      className="flex min-h-[52px] w-full items-center gap-3 rounded-[14px] border border-border bg-card px-4 py-3 text-left text-[15px] hover:border-[#BDB8AC] hover:shadow-[0_4px_14px_rgb(60_50_30/6%)] disabled:opacity-60"
                    >
                      <MessageSquare className="size-[18px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 break-words">{text}</span>
                      <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground max-sm:hidden">
                        直接开始对话
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mb-[34px]">
            <h2 className="mb-3 font-display text-[22px] font-bold">输入与输出</h2>
            <p className="-mt-1 mb-3.5 text-sm text-muted-foreground">
              用 API 调用时按输入契约传参，返回结果符合输出契约，可以直接被你的系统解析。
            </p>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <Contract
                label="输入契约"
                schema={agent.config.inputSchema}
                empty="未声明输入契约，按自由文本提问。"
              />
              <Contract
                label="输出契约"
                schema={agent.config.outputSchema}
                empty="未声明输出契约，返回自由文本。"
              />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <PriceCard agent={agent} price={price} />
          <div className="rounded-2xl border border-border bg-card px-[22px] py-5">
            <h3 className="mb-3 text-[15px] font-semibold">版本说明</h3>
            <div className="flex items-center gap-2 text-sm">
              <b className="font-display text-base">v{agent.publishedVersion}</b>
              {published && <span className="text-muted-foreground">{published}</span>}
              <Badge variant="success" className="ml-auto">
                当前版本
              </Badge>
            </div>
            <p className="mt-1.5 text-sm break-words text-[#3C3A35]">
              {agent.versionNote || "作者没有写这一版的说明。"}
            </p>
            <p className="mt-2.5 text-xs text-muted-foreground">
              立即使用跑的是当前发布版；API 调用可以传 version 锁定某一版。
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-[22px] py-5">
            <h3 className="mb-3 text-[15px] font-semibold">基本信息</h3>
            <Kv label="ID">
              <span className="font-mono text-[13px] break-all">{agent.id}</span>
            </Kv>
            <Kv label="分类">{category}</Kv>
            {agent.author && <Kv label="作者">{agent.author}</Kv>}
            <Kv label="当前版本">
              v{agent.publishedVersion}
              {published ? `（${published}）` : ""}
            </Kv>
          </div>
        </aside>
      </div>
    </>
  );
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line-soft py-2 text-sm last:border-b-0">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function Contract({ label, schema, empty }: { label: string; schema: unknown; empty: string }) {
  const text = schema ? JSON.stringify(schema, null, 2) : "";
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between text-sm font-semibold">
        {label}
        {text && (
          <Button
            variant="ghost"
            size="xs"
            className="max-md:h-11"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(text)
                .then(() => toast.success(`已复制${label}`))
                .catch(() => toast.error("复制失败，请手动选择文本"))
            }
          >
            <Copy />
            复制
          </Button>
        )}
      </div>
      {text ? (
        <pre className="max-h-96 min-h-[210px] overflow-auto rounded-xl bg-[#1F1E1C] px-4 py-3.5 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-[#EAE6DC]">
          {text}
        </pre>
      ) : (
        <div className="min-h-[210px] rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </div>
  );
}

function PriceCard({ agent, price }: { agent: MarketAgent; price: string | null }) {
  const catalog = useModelCatalog();
  const model = agent.config.model ? modelOf(catalog, agent.config.model) : undefined;
  const input = model ? perStandard(model.rates, "input_token", "1000000") : null;
  const output = model ? perStandard(model.rates, "output_token", "1000000") : null;
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchJson<{ balance: { availableMicroCredits: string } }>("/api/billing?limit=1")
      .then((r) => alive && setBalance(creditsBalance(r.balance.availableMicroCredits)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-card px-[22px] py-5">
      <h3 className="mb-3 text-[15px] font-semibold">价格</h3>
      <p className="font-display text-[28px] font-bold">
        {price ? price.replace(/\/次$/, "") : "按用量计费"}
        {price && (
          <span className="ml-1 font-sans text-[15px] font-normal text-muted-foreground">每次</span>
        )}
      </p>
      <p className="mt-1.5 mb-3 text-[13px] text-muted-foreground">
        {price
          ? "最近成功运行的平均实扣。按实际 token 结算，从你的积分里扣；单次用量随输入长度变化。"
          : "还没有足够的运行记录估算每次花费，按模型单价和实际 token 结算。"}
      </p>
      <Kv label="模型">
        <span className="font-mono text-[13px] break-all">
          {model?.name ?? agent.config.model ?? "默认模型"}
        </span>
      </Kv>
      <Kv label="模型单价">
        <span data-testid="market-model-unit">
          {!catalog
            ? "—"
            : !model?.available
              ? "模型暂不可用"
              : input && output
                ? `输入 ${creditsText(input.micro)}／输出 ${creditsText(output.micro)} 积分每百万 token`
                : "—"}
        </span>
      </Kv>
      {balance !== null && <Kv label="你的余额">{balance} 积分</Kv>}
      <Link
        href="/account/prices"
        className="mt-1 inline-block text-[13px] underline decoration-[#C9C4B8] underline-offset-[3px] hover:decoration-foreground"
      >
        查看全部模型价格
      </Link>
    </div>
  );
}
