"use client";

import { SpaceShell } from "@/components/space-shell";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ACTION_LABEL,
  type AuditItem,
  SENSITIVE,
  actionGroups,
  actionLabel,
  actorLabel,
  describeAudit,
} from "@/features/audit/labels";
import { EmptyState, SpacePage, tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const GROUPS = actionGroups();

/**
 * 审计日志:谁在什么时候对什么做了什么。
 *
 * 看得到的范围:你名下资源上发生的事(包括别人对你分享出去的智能体的修改、
 * 有人尝试登录你的账号),以及你自己做的操作。管理员可以看全平台。
 * 个人页直接用 AppShell(SpacePage);平台审计仍在 SpaceShell 里,阶段 7 再换。
 */
export function AuditView({ platform = false }: { platform?: boolean }) {
  if (platform) {
    return (
      <SpaceShell area="admin" title="平台审计" subtitle="全平台账号与资源的操作记录">
        <AuditContent platform />
      </SpaceShell>
    );
  }
  return (
    <SpacePage
      side="account"
      title="操作日志"
      subtitle="你做过的操作，以及别人（管理员、你的 Key）对你的资源做的操作。标黄的是需要留意的操作。"
    >
      <AuditContent platform={false} />
    </SpacePage>
  );
}

/** 操作者头像字:Key 用深色,匿名用浅灰,账号取邮箱首字 */
function ActorFace({ actor }: { actor: AuditItem["actor"] }) {
  const label = actorLabel(actor);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
        actor.type === "apiKey" && "bg-[#1F1E1C] text-white",
        actor.type === "anonymous" && "bg-[#F1EFEA] text-muted-foreground",
        actor.type === "user" && "bg-[#D9D1C1] text-[#3B362D]",
      )}
    >
      {actor.type === "apiKey" ? "K" : (label.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function AuditContent({ platform }: { platform: boolean }) {
  const [action, setAction] = useState("");
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
      if (platform) q.set("scope", "all");
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
    [action, platform],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const label = action ? (ACTION_LABEL as Record<string, string>)[action] : "";

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <NativeSelect
          className="w-[260px] max-sm:w-full"
          aria-label="按操作类型筛选"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">全部操作类型</option>
          {GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.actions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </optgroup>
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
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn("size-[15px]", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <section
        aria-label="操作记录"
        className="overflow-hidden rounded-2xl border border-border bg-card"
      >
        {error ? (
          <EmptyState
            title="操作记录没有载入"
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
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={label ? `没有「${label}」的记录` : "还没有操作记录"}
            action={
              label ? (
                <Button variant="outline" onClick={() => setAction("")}>
                  看全部类型
                </Button>
              ) : undefined
            }
          >
            {label ? "换一个操作类型试试。" : undefined}
          </EmptyState>
        ) : (
          <div className={tb.wrap}>
            <table className={cn(tb.table, "min-w-[820px]")}>
              <caption className="sr-only">操作记录</caption>
              <thead>
                <tr>
                  <th scope="col" className={cn(tb.th, tb.first)}>
                    时间
                  </th>
                  <th scope="col" className={tb.th}>
                    操作者
                  </th>
                  <th scope="col" className={tb.th}>
                    操作
                  </th>
                  <th scope="col" className={tb.th}>
                    内容
                  </th>
                  <th scope="col" className={cn(tb.th, tb.last)}>
                    来源地址
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const sensitive = SENSITIVE.has(e.action);
                  const text = describeAudit(e);
                  return (
                    <tr key={e.id}>
                      <td className={cn(tb.td, tb.first, tb.num)}>
                        <span title={new Date(e.at).toLocaleString()}>{shortTime(e.at)}</span>
                      </td>
                      <td className={tb.td}>
                        <span className="flex max-w-56 items-center gap-2" title={e.actor.id}>
                          <ActorFace actor={e.actor} />
                          <span className="truncate">{actorLabel(e.actor)}</span>
                        </span>
                      </td>
                      <td
                        className={cn(
                          tb.td,
                          "whitespace-nowrap",
                          sensitive && "font-semibold text-warning-text",
                        )}
                      >
                        {sensitive && (
                          <AlertTriangle className="mr-1 inline size-3.5 align-[-2px]" />
                        )}
                        {actionLabel(e.action)}
                      </td>
                      <td className={cn(tb.td, "max-w-96 break-words")}>
                        {text || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td
                        className={cn(tb.td, tb.last, "font-mono text-[12.5px] whitespace-nowrap")}
                      >
                        {e.ip ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!error && items.length > 0 && (
          <div className="flex justify-center p-3.5">
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
              <span className="text-xs text-muted-foreground">没有更早的记录了</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
