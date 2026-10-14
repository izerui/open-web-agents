"use client";

import { RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";

interface Delivery {
  id: string;
  runId?: string;
  trigger: "auto" | "test";
  attempt?: number;
  url: string;
  httpStatus?: number;
  ok: boolean;
  error?: string;
  durationMs: number;
  signed: boolean;
  at: number;
}

/**
 * 回调投递记录:每次发了什么地址、对方回了什么、为什么失败;可发测试事件、可重发失败的回调。
 * 只有智能体所有者能看(接口会拒绝其他人)。
 */
export function WebhookDeliveries({
  agentId,
  webhookUrl,
}: { agentId: string; webhookUrl?: string }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (more?: string) => {
      try {
        const q = new URLSearchParams({ limit: "20" });
        if (more) q.set("cursor", more);
        const d = await fetchJson<{ items: Delivery[]; nextCursor?: string }>(
          `/api/agents/${encodeURIComponent(agentId)}/webhook/deliveries?${q}`,
        );
        setItems((cur) => (more && cur ? [...cur, ...d.items] : d.items));
        setCursor(d.nextCursor);
      } catch (e) {
        setItems([]);
        toast.error(`投递记录加载失败:${errorText(e)}`);
      }
    },
    [agentId],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function sendTest() {
    setBusy("test");
    try {
      const d = await fetchJson<{ delivery: Delivery }>(
        `/api/agents/${encodeURIComponent(agentId)}/webhook/test`,
        { method: "POST" },
      );
      if (d.delivery.ok) toast.success(`测试回调已送达(HTTP ${d.delivery.httpStatus})`);
      else toast.error(`测试回调失败:${d.delivery.error ?? `HTTP ${d.delivery.httpStatus}`}`);
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function redeliver(runId: string) {
    setBusy(runId);
    try {
      await fetchJson(`/api/runs/${encodeURIComponent(runId)}/webhook/redeliver`, {
        method: "POST",
      });
      toast.success("已放回发件箱,几秒后会重新投递");
      setTimeout(() => void load(), 3000);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-xs">回调投递记录</span>
        <span className="text-xs text-muted-foreground">
          {webhookUrl ? "地址在构建器里配置;签名密钥见下方" : "未配置回调地址"}
        </span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="h-8" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!webhookUrl || busy !== null}
            onClick={() => void sendTest()}
          >
            <Send className="size-3.5" />
            {busy === "test" ? "发送中…" : "发送测试"}
          </Button>
        </div>
      </div>
      <div className="divide-y divide-border rounded border text-xs">
        {items === null && <p className="p-3 text-muted-foreground">载入中…</p>}
        {items?.length === 0 && <p className="p-3 text-muted-foreground">还没有投递记录</p>}
        {items?.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
            <span className="w-36 shrink-0 text-muted-foreground">
              {new Date(d.at).toLocaleString()}
            </span>
            <Badge variant={d.ok ? "success" : "warning"} className="text-[11px]">
              {d.ok ? "成功" : "失败"}
              {d.httpStatus ? ` · ${d.httpStatus}` : ""}
            </Badge>
            <span className="text-muted-foreground">
              {d.trigger === "test" ? "测试" : `运行 ${d.runId?.slice(0, 8)}… · 第 ${d.attempt} 次`}
            </span>
            <span className="text-muted-foreground">{d.durationMs}ms</span>
            {!d.signed && <span className="text-warning">未签名</span>}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                d.error ? "text-destructive" : "text-muted-foreground",
              )}
              title={d.error ?? d.url}
            >
              {d.error ?? d.url}
            </span>
            {!d.ok && d.trigger === "auto" && d.runId && (
              <Button
                size="sm"
                variant="link"
                className="h-7 px-1"
                disabled={busy !== null}
                onClick={() => void redeliver(d.runId as string)}
              >
                重发
              </Button>
            )}
          </div>
        ))}
      </div>
      {cursor && (
        <Button size="sm" variant="ghost" onClick={() => void load(cursor)}>
          加载更多
        </Button>
      )}
    </div>
  );
}
