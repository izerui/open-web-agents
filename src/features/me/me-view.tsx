"use client";

import { AppShell } from "@/components/shell/app-shell";
import { useBalance } from "@/components/shell/use-balance";
import { useLogout } from "@/components/shell/use-logout";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/fetch-json";
import { initialsOf, isAdminView, useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Activity, ChevronRight, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ORDERS_HREF,
  type MeRow as Row,
  meAccountRows,
  pendingOrdersHint,
  recentRunsHint,
} from "./me-logic";

/** 原型手机端没有开发者与管理空间;产品里有,放在下面一组,窄屏也能进 */
const MORE_ROWS: Row[] = [
  { href: "/developer/keys", label: "API Key 与签名密钥", icon: KeyRound },
  { href: "/developer/runs", label: "运行记录", icon: Activity },
];

const ROW =
  "flex min-h-14 w-full items-center gap-3 border-b border-line-soft px-1 py-1.5 text-left text-base last:border-b-0";

/**
 * 「我的」聚合页(取舍 11,原型 mobile.html vMe):手机底部标签栏的第四个标签。
 * 可用积分大卡、充值与订单、账号相关入口、登出前确认。桌面上也能打开,归在账户空间下。
 */
export function MeView() {
  const { me, loading } = useMe();
  const local = me?.authRequired === false && !me.user;
  const balance = useBalance(Boolean(me?.authenticated || me?.authRequired === false));
  const logout = useLogout();
  /** 登出确认:窄屏是底部抽屉(原型 mobile.html),桌面是居中弹窗 */
  const [confirm, setConfirm] = useState<"sheet" | "dialog" | null>(null);
  const hints = useRowHints(Boolean(me?.authenticated && !local), Boolean(me && !loading));
  const email = me?.user?.email ?? "";
  const name = local ? "本地模式" : (email.split("@")[0] ?? email);
  const role = local ? "匿名管理员" : isAdminView(me) ? "管理员" : "普通账号";
  const rows = [
    ...MORE_ROWS,
    ...(isAdminView(me) ? [{ href: "/admin/accounts", label: "平台管理", icon: ShieldCheck }] : []),
  ];

  return (
    <AppShell side="account">
      <div className="mx-auto w-full max-w-xl px-4 pt-5 pb-10">
        <h1 className="mb-4 font-display text-[26px] leading-tight font-bold">我的</h1>

        {loading ? (
          <Skeleton className="h-14 w-full rounded-2xl" />
        ) : (
          <div className="mb-2 flex items-center gap-3.5">
            <span className="grid size-14 shrink-0 place-items-center rounded-full bg-[#D9D1C1] text-[22px] font-semibold text-[#3B362D]">
              {local ? "本" : email ? initialsOf(email) : "?"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[19px] font-semibold">{name || "账号信息未读取到"}</p>
              {!local && email && <p className="truncate text-sm text-muted-foreground">{email}</p>}
            </div>
            <Badge variant="outline" className="shrink-0">
              {role}
            </Badge>
          </div>
        )}

        {balance.status !== "none" && (
          <section
            aria-label="积分"
            className="my-3.5 rounded-[20px] border border-border bg-card px-[18px] py-4"
          >
            <p className="text-[13px] text-muted-foreground">可用积分</p>
            <p className="mt-0.5 mb-2.5 font-display text-[38px] leading-tight font-bold tabular-nums">
              {balance.status === "ok" ? balance.available : "—"}
            </p>
            <div className="mb-3 grid grid-cols-3 border-t border-line-soft pt-2.5">
              <Kv label="冻结中" value={balance.status === "ok" ? balance.reserved : "—"} />
              <Kv label="本月已用" value={balance.status === "ok" ? balance.monthUsed : "—"} />
              <Kv
                label="月度上限"
                value={balance.status === "ok" ? (balance.monthLimit ?? "未设置") : "—"}
              />
            </div>
            <div className="flex gap-2">
              <Button asChild className="h-[46px] flex-1">
                <Link href="/account/billing?tab=packages">充值积分包</Link>
              </Button>
              <Button asChild variant="outline" className="h-[46px] flex-1">
                <Link href={ORDERS_HREF}>我的订单</Link>
              </Button>
            </div>
          </section>
        )}

        <RowList rows={meAccountRows(local)} hints={hints} />
        <RowList rows={rows} />

        {me?.authenticated && !local && (
          <div className="mb-3 rounded-[18px] border border-border bg-card px-3">
            <button
              type="button"
              className={cn(ROW, "text-destructive")}
              onClick={() =>
                setConfirm(window.matchMedia("(max-width: 767px)").matches ? "sheet" : "dialog")
              }
            >
              <LogOut className="size-5" aria-hidden="true" />
              登出
            </button>
          </div>
        )}
      </div>

      <Sheet open={confirm === "sheet"} onOpenChange={(open) => !open && setConfirm(null)}>
        <SheetContent
          side="bottom"
          className="gap-0 rounded-t-[26px] border-0 pb-[max(28px,env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto mt-2 mb-0.5 h-[5px] w-10 rounded-full bg-[#D9D5CB]" aria-hidden />
          <SheetHeader className="px-5 pt-1.5 pb-1">
            <SheetTitle className="font-sans text-[17px] font-semibold">退出登录？</SheetTitle>
            <SheetDescription className="text-[15px] text-[#3C3A35]">
              退出后需要重新输入邮箱和密码。
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-5 pt-2">
            <Button
              className="h-12 w-full border-transparent bg-destructive text-base text-white hover:bg-destructive/90"
              onClick={() => {
                setConfirm(null);
                void logout();
              }}
            >
              登出
            </Button>
            <Button
              variant="ghost"
              className="h-12 w-full text-base"
              onClick={() => setConfirm(null)}
            >
              取消
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={confirm === "dialog"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>退出登录？</DialogTitle>
            <DialogDescription>退出后需要重新输入邮箱和密码。</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              className="h-11 border-transparent bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setConfirm(null);
                void logout();
              }}
            >
              登出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-[13px] text-muted-foreground">
      <b className="block text-[17px] font-semibold text-foreground tabular-nums">{value}</b>
      {label}
    </div>
  );
}

/**
 * 入口右侧的附加信息(原型「1 个待处理」「近 7 天 286 次」):待处理订单数、近 7 天运行数。
 * 用现成接口;读不到就不显示,不影响入口本身。
 */
function useRowHints(withOrders: boolean, ready: boolean): Record<string, string> {
  const [hints, setHints] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const set = (href: string, text: string) =>
      alive && text && setHints((h) => ({ ...h, [href]: text }));
    if (withOrders) {
      void fetchJson<{ items?: { status: string }[] }>("/api/billing/orders")
        .then((d) => set(ORDERS_HREF, pendingOrdersHint(d.items ?? [])))
        .catch(() => {});
    }
    void fetchJson<{ totals?: { runs: number }; truncated?: boolean }>("/api/usage?days=7")
      .then((d) => set("/account/usage", recentRunsHint(d.totals, d.truncated)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [withOrders, ready]);
  return hints;
}

function RowList({ rows, hints = {} }: { rows: Row[]; hints?: Record<string, string> }) {
  return (
    <nav className="mb-3 rounded-[18px] border border-border bg-card px-3">
      {rows.map((r) => (
        <Link key={r.href} href={r.href} className={ROW}>
          <r.icon className="size-5 shrink-0" aria-hidden="true" />
          {r.label}
          <span className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
            {hints[r.href]}
            <ChevronRight className="size-4" aria-hidden="true" />
          </span>
        </Link>
      ))}
    </nav>
  );
}
