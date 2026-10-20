"use client";

import { SpaceShell } from "@/components/space-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ModelPrice } from "@/features/models/model-price";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { ArrowLeft, Bot } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MarketActions } from "./market-actions";

export function MarketDetail({ id }: { id: string }) {
  const [agent, setAgent] = useState<MarketAgent | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh retries the current detail request.
  useEffect(() => {
    const controller = new AbortController();
    setAgent(null);
    setError("");
    void fetchJson<{ agent: MarketAgent }>(`/api/market/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setAgent(result.agent);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      });
    return () => controller.abort();
  }, [id, refresh]);
  return (
    <SpaceShell area="market" title={agent?.name ?? "智能体详情"}>
      <Link
        href="/market"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        返回市场
      </Link>
      {error ? (
        <Alert>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : !agent ? (
        <p className="text-sm text-muted-foreground">正在加载…</p>
      ) : (
        <>
          <div className="flex items-start gap-4 border-b border-border pb-6">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted">
              <Bot className="size-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <h2 className="break-words text-xl font-semibold">{agent.name}</h2>
              <p className="break-words text-sm text-muted-foreground">
                {agent.description || "暂无说明"}
              </p>
              <p className="text-xs text-muted-foreground">
                {MARKET_CATEGORIES.find((c) => c.id === agent.category)?.name} · v
                {agent.publishedVersion}
              </p>
              <p className="text-xs text-muted-foreground">
                <ModelPrice model={agent.config.model} />
              </p>
              <MarketActions agentId={agent.id} />
            </div>
          </div>
          {agent.config.starters?.length ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">示例问题</h2>
              <ul className="list-disc space-y-2 pl-5 text-sm">
                {agent.config.starters.map((text, index) => (
                  <li key={`${index}-${text}`} className="break-words">
                    {text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {(["inputSchema", "outputSchema"] as const).map((key) =>
            agent.config[key] ? (
              <details key={key} className="border-b border-border pb-4">
                <summary className="cursor-pointer text-sm font-medium">
                  {key === "inputSchema" ? "输入契约" : "输出契约"}
                </summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs">
                  {JSON.stringify(agent.config[key], null, 2)}
                </pre>
              </details>
            ) : null,
          )}
        </>
      )}
    </SpaceShell>
  );
}
