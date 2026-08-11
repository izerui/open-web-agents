"use client";

import { SettingsShell } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatUsd } from "@/lib/modules/usage/domain/aggregate";
import { peekMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Ban, Check, ShieldCheck, User as UserIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Account {
  id: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
  assistantCount: number;
  monthCostMicroUsd: number;
  monthlyQuotaMicroUsd: number | null;
}

/** 微美元 ↔ 美元。界面上填的是美元,存的是微美元。 */
const toMicro = (usd: number) => Math.round(usd * 1_000_000);
const toUsd = (micro: number) => micro / 1_000_000;

/**
 * 平台账号管理。
 *
 * 【为什么这个页面必须存在】role 只在注册时定死(第一个注册者是 admin),
 * 代码里原本没有任何接口能改它 —— 加个管理员、停用一个滥用的账号,
 * 都只能连数据库跑 SQL。一个要交给运营的平台不能是这样。
 */
export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});

  const selfId = peekMe()?.user?.id;

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ accounts?: Account[] }>("/api/admin/accounts");
      setAccounts(d.accounts ?? []);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>, okMsg: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) {
        // 服务端的拒绝理由写得很具体(如"这是最后一位管理员"),原样呈现
        toast.error(d.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(okMsg);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function saveQuota(a: Account) {
    const raw = quotaDraft[a.id]?.trim() ?? "";
    // 清空 = 取消限额,和"填 0"是两回事(0 意味着一分钱都不许花)
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error("额度要填一个非负数字,或留空表示不限");
      return;
    }
    await patch(
      a.id,
      { monthlyQuotaMicroUsd: value === null ? null : toMicro(value) },
      value === null ? "已取消该账号的额度限制" : `额度已设为 $${value}`,
    );
    setQuotaDraft((m) => {
      const next = { ...m };
      delete next[a.id];
      return next;
    });
  }

  const totalCost = accounts.reduce((s, a) => s + a.monthCostMicroUsd, 0);
  const activeCount = accounts.filter((a) => !a.disabled).length;

  return (
    <SettingsShell
      area="admin"
      title="账号管理"
      subtitle={`${accounts.length} 个账号 · ${activeCount} 个启用中 · 本月合计 ${formatUsd(totalCost)}`}
    >
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          载入中…
        </div>
      )}

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 p-4">
            <p className="text-xs text-destructive">账号列表加载失败:{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && accounts.length === 0 && (
        <p className="text-xs text-muted-foreground">还没有任何账号</p>
      )}

      <div className="space-y-2">
        {accounts.map((a) => {
          const isSelf = a.id === selfId;
          const over =
            a.monthlyQuotaMicroUsd !== null && a.monthCostMicroUsd >= a.monthlyQuotaMicroUsd;
          return (
            <Card key={a.id} className={cn(a.disabled && "opacity-60")}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.email}</span>
                  {a.role === "admin" && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      <ShieldCheck className="size-3" />
                      管理员
                    </Badge>
                  )}
                  {a.disabled && (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      已停用
                    </Badge>
                  )}
                  {isSelf && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      你自己
                    </Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>注册于 {new Date(a.createdAt).toLocaleDateString()}</span>
                  <span>{a.assistantCount} 个智能体</span>
                  <span className={cn(over && "font-medium text-[var(--warning)]")}>
                    本月 {formatUsd(a.monthCostMicroUsd)}
                    {a.monthlyQuotaMicroUsd !== null &&
                      ` / 上限 ${formatUsd(a.monthlyQuotaMicroUsd)}`}
                    {over && " —— 已超额"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">月度上限 $</span>
                    <Input
                      className="h-7 w-24 text-xs"
                      inputMode="decimal"
                      placeholder={a.monthlyQuotaMicroUsd === null ? "不限" : ""}
                      value={
                        quotaDraft[a.id] ??
                        (a.monthlyQuotaMicroUsd === null
                          ? ""
                          : String(toUsd(a.monthlyQuotaMicroUsd)))
                      }
                      onChange={(e) => setQuotaDraft((m) => ({ ...m, [a.id]: e.target.value }))}
                    />
                  </label>
                  {quotaDraft[a.id] !== undefined && (
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={busy === a.id}
                      onClick={() => void saveQuota(a)}
                    >
                      <Check className="size-3.5" />
                      保存额度
                    </Button>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {/*
                      【为什么对自己禁用这两个按钮】把自己降级或停用,做完就再也
                      进不来了 —— 服务端也挡了这一手,这里只是别让人白点一次。
                    */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      disabled={isSelf || busy === a.id}
                      title={isSelf ? "不能改自己的角色" : undefined}
                      onClick={() =>
                        void patch(
                          a.id,
                          { role: a.role === "admin" ? "user" : "admin" },
                          a.role === "admin" ? "已取消管理员" : "已设为管理员",
                        )
                      }
                    >
                      {a.role === "admin" ? (
                        <>
                          <UserIcon className="size-3.5" />
                          取消管理员
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="size-3.5" />
                          设为管理员
                        </>
                      )}
                    </Button>

                    <Button
                      variant={a.disabled ? "outline" : "ghost"}
                      size="sm"
                      className={cn("h-7", !a.disabled && "text-destructive")}
                      disabled={isSelf || busy === a.id}
                      title={isSelf ? "不能停用自己" : undefined}
                      onClick={() =>
                        void patch(
                          a.id,
                          { disabled: !a.disabled },
                          a.disabled ? "已恢复该账号" : "已停用该账号,其登录立即失效",
                        )
                      }
                    >
                      <Ban className="size-3.5" />
                      {a.disabled ? "恢复" : "停用"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </SettingsShell>
  );
}
