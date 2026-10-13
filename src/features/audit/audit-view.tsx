"use client";

import { SpaceShell } from "@/components/space-shell";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ACTION_LABEL,
  type AuditItem,
  SENSITIVE,
  actionLabel,
  actorLabel,
  describeAudit,
} from "@/features/audit/labels";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 审计日志:谁在什么时候对什么做了什么。
 *
 * 看得到的范围:你名下资源上发生的事(包括别人对你分享出去的智能体的修改、
 * 有人尝试登录你的账号),以及你自己做的操作。管理员可以看全平台。
 */
export function AuditView() {
  const { me } = useMe();
  const isAdmin = me?.user?.role === "admin";
  const [action, setAction] = useState("");
  const [scopeAll, setScopeAll] = useState(false);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(
    async (append?: string) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      const q = new URLSearchParams({ limit: "50" });
      if (action) q.set("action", action);
      if (scopeAll) q.set("scope", "all");
      if (append) q.set("cursor", append);
      try {
        const d = await fetchJson<{ items: AuditItem[]; nextCursor?: string }>(`/api/audit?${q}`);
        if (seq !== seqRef.current) return;
        setItems((cur) => (append ? [...cur, ...d.items] : d.items));
        setCursor(d.nextCursor);
      } catch (e) {
        if (seq === seqRef.current) setError(errorText(e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [action, scopeAll],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SpaceShell
      title="审计日志"
      subtitle="你名下资源上发生的操作,以及你自己的操作"
      actions={
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          className="h-8 w-48 text-xs"
          aria-label="按操作筛选"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">全部操作</option>
          {Object.entries(ACTION_LABEL).map(([k, v]) => (
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
              <th className="px-3 py-2 font-medium">操作者</th>
              <th className="px-3 py-2 font-medium">操作</th>
              <th className="px-3 py-2 font-medium">内容</th>
              <th className="px-3 py-2 font-medium">来源地址</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {new Date(e.at).toLocaleString()}
                </td>
                <td className="max-w-48 truncate px-3 py-2" title={e.actor.id}>
                  {actorLabel(e.actor)}
                </td>
                <td
                  className={cn(
                    "whitespace-nowrap px-3 py-2",
                    SENSITIVE.has(e.action) && "text-warning",
                  )}
                >
                  {actionLabel(e.action)}
                </td>
                <td className="max-w-96 break-words px-3 py-2 text-muted-foreground">
                  {describeAudit(e)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{e.ip ?? "—"}</td>
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
          <p className="p-6 text-center text-xs text-muted-foreground">没有符合条件的记录</p>
        )}
      </div>

      {cursor && (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load(cursor)}
          className="self-center"
        >
          {loading ? "载入中…" : "加载更多"}
        </Button>
      )}
    </SpaceShell>
  );
}
