"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatUsd, toMicroUsd } from "@/lib/modules/usage/domain/aggregate";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface RunItem {
  id: string;
  sessionId: string;
  agentId: string;
  agentName?: string;
  /** 执行的智能体版本;undefined = 草稿 */
  agentVersion?: number;
  source: "web" | "api" | "invoke" | "embed" | "eval" | "design";
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  promptPreview: string;
  createdAt: number;
  durationMs?: number;
  cost?: { usd?: number; input?: number; output?: number; partial?: boolean };
  error?: { kind?: string; message?: string };
}

interface RunDetail extends RunItem {
  prompt: string;
  finalText?: string;
  structured?: unknown;
}

const SOURCE_LABEL: Record<RunItem["source"], string> = {
  web: "工作台",
  api: "API 会话",
  invoke: "接口调用",
  eval: "评测",
  embed: "嵌入组件",
  design: "AI 编辑",
};

const STATUS_META: Record<RunItem["status"], { label: string; className: string }> = {
  pending: { label: "排队中", className: "bg-muted text-muted-foreground" },
  running: { label: "运行中", className: "bg-brand/15 text-brand" },
  success: { label: "成功", className: "bg-success/15 text-success" },
  failed: { label: "失败", className: "bg-destructive/15 text-destructive" },
  cancelled: { label: "已取消", className: "bg-muted text-muted-foreground" },
};

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function formatCost(cost?: RunItem["cost"]): string {
  if (!cost) return "—";
  if (cost.usd) return formatUsd(toMicroUsd(cost.usd));
  const tokens = (cost.input ?? 0) + (cost.output ?? 0);
  return tokens ? `${tokens.toLocaleString()} tokens${cost.partial ? "(部分)" : ""}` : "—";
}

/**
 * 运行记录:我名下的全部运行 —— 工作台里的对话,以及用我的 Key 发起的接口调用和嵌入对话。
 *
 * 曾经接口调用的过程与结果只能凭 taskId 逐个去查,工作台里也看不到;
 * 这里是两个入口统一的观察窗口。
 */
export function RunsView() {
  const { me } = useMe();
  const isAdmin = me?.user?.role === "admin";
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [scopeAll, setScopeAll] = useState(false);
  const [items, setItems] = useState<RunItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    void fetchJson<{ agents?: { id: string; name: string }[] }>("/api/agents")
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(
    async (append?: string) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ limit: "30" });
      if (agentId) q.set("agentId", agentId);
      if (status) q.set("status", status);
      if (source) q.set("source", source);
      if (scopeAll) q.set("scope", "all");
      if (append) q.set("cursor", append);
      try {
        const d = await fetchJson<{ items: RunItem[]; nextCursor?: string }>(`/api/runs?${q}`);
        if (seq !== seqRef.current) return;
        setItems((cur) => (append ? [...cur, ...d.items] : d.items));
        setCursor(d.nextCursor);
      } catch (e) {
        if (seq === seqRef.current) setError(errorText(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [agentId, status, source, scopeAll],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    try {
      const d = await fetchJson<{ run: RunDetail }>(`/api/runs/${id}`);
      setDetail(d.run);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <SpaceShell
      title="运行记录"
      subtitle="工作台对话,以及用你的 Key 发起的接口调用与嵌入对话"
      actions={
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          className="h-8 w-44 text-xs"
          aria-label="按智能体筛选"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">全部智能体</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          className="h-8 w-32 text-xs"
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
          className="h-8 w-32 text-xs"
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
        {isAdmin && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={scopeAll}
              onChange={(e) => setScopeAll(e.target.checked)}
            />
            全平台
          </label>
        )}
      </div>

      {error && <p className="text-xs text-destructive">加载失败:{error}</p>}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">智能体</th>
              <th className="px-3 py-2 font-medium">来源</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">输入</th>
              <th className="px-3 py-2 text-right font-medium">耗时</th>
              <th className="px-3 py-2 text-right font-medium">花费</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                className="cursor-pointer border-t border-border hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
                onClick={() => void openDetail(r.id)}
                onKeyDown={(e) => e.key === "Enter" && void openDetail(r.id)}
              >
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="max-w-40 truncate px-3 py-2">
                  {r.agentName ?? r.agentId}
                  <span className="ml-1 text-muted-foreground">
                    {r.agentVersion ? `v${r.agentVersion}` : "草稿"}
                  </span>
                </td>
                <td className="px-3 py-2">{SOURCE_LABEL[r.source]}</td>
                <td className="px-3 py-2">
                  <Badge className={cn("border-0", STATUS_META[r.status].className)}>
                    {STATUS_META[r.status].label}
                  </Badge>
                </td>
                <td className="max-w-80 truncate px-3 py-2 text-muted-foreground">
                  {r.promptPreview}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {formatDuration(r.durationMs)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">{formatCost(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && items.length === 0 && (
          <div className="space-y-2 p-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        )}
        {!loading && items.length === 0 && !error && (
          <p className="p-6 text-center text-xs text-muted-foreground">没有符合条件的运行</p>
        )}
      </div>

      {cursor && (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load(cursor)}
          className="self-start"
        >
          加载更多
        </Button>
      )}

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {detail.agentName ?? detail.agentId}
                  <span className="ml-2 font-normal text-muted-foreground text-sm">
                    {detail.agentVersion ? `v${detail.agentVersion}` : "草稿"}
                  </span>
                </SheetTitle>
                <SheetDescription>
                  {new Date(detail.createdAt).toLocaleString()} · {SOURCE_LABEL[detail.source]} ·{" "}
                  {STATUS_META[detail.status].label} · {formatDuration(detail.durationMs)} ·{" "}
                  {formatCost(detail.cost)}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6 text-sm">
                <section className="space-y-1">
                  <h3 className="text-xs text-muted-foreground">输入</h3>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                    {detail.prompt}
                  </pre>
                </section>
                {detail.error?.message && (
                  <section className="space-y-1">
                    <h3 className="text-xs text-muted-foreground">
                      错误{detail.error.kind ? `(${detail.error.kind})` : ""}
                    </h3>
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                      {detail.error.message}
                    </p>
                  </section>
                )}
                {detail.structured !== undefined && (
                  <section className="space-y-1">
                    <h3 className="text-xs text-muted-foreground">结构化结果</h3>
                    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                      {JSON.stringify(detail.structured, null, 2)}
                    </pre>
                  </section>
                )}
                {detail.finalText && (
                  <section className="space-y-1">
                    <h3 className="text-xs text-muted-foreground">最终回答</h3>
                    <div className="rounded-md border border-border p-2">
                      <MessageResponse>{detail.finalText}</MessageResponse>
                    </div>
                  </section>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    window.open(`/?session=${encodeURIComponent(detail.sessionId)}`, "_blank")
                  }
                >
                  <ExternalLink className="size-3.5" />
                  在工作台查看完整过程
                </Button>
                <p className="font-mono text-[11px] text-muted-foreground">taskId: {detail.id}</p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </SpaceShell>
  );
}
