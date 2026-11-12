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
import { Skeleton } from "@/components/ui/skeleton";
import { initialsOf, isAdminView, useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import {
  Activity,
  BarChart3,
  ChevronRight,
  KeyRound,
  List,
  Lock,
  LogOut,
  type LucideIcon,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Tag,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type Row = { href: string; label: string; icon: LucideIcon };

/** 原型「我的」页的六个入口 */
const ACCOUNT_ROWS: Row[] = [
  { href: "/account/billing?tab=packages", label: "我的订单", icon: ReceiptText },
  { href: "/account/billing?tab=ledger", label: "积分流水", icon: List },
  { href: "/account/usage", label: "用量", icon: BarChart3 },
  { href: "/account/prices", label: "模型价格", icon: Tag },
  { href: "/account/security", label: "账号安全", icon: Lock },
  { href: "/account/audit", label: "操作日志", icon: ScrollText },
];

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
  const [confirm, setConfirm] = useState(false);
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
                <Link href="/account/billing?tab=packages">我的订单</Link>
              </Button>
            </div>
          </section>
        )}

        <RowList rows={local ? ACCOUNT_ROWS.slice(2) : ACCOUNT_ROWS} />
        <RowList rows={rows} />

        {me?.authenticated && !local && (
          <div className="mb-3 rounded-[18px] border border-border bg-card px-3">
            <button
              type="button"
              className={cn(ROW, "text-destructive")}
              onClick={() => setConfirm(true)}
            >
              <LogOut className="size-5" aria-hidden="true" />
              登出
            </button>
          </div>
        )}
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>退出登录？</DialogTitle>
            <DialogDescription>退出后需要重新输入邮箱和密码。</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11" onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              onClick={() => {
                setConfirm(false);
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

function RowList({ rows }: { rows: Row[] }) {
  return (
    <nav className="mb-3 rounded-[18px] border border-border bg-card px-3">
      {rows.map((r) => (
        <Link key={r.href} href={r.href} className={ROW}>
          <r.icon className="size-5 shrink-0" aria-hidden="true" />
          {r.label}
          <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
        </Link>
      ))}
    </nav>
  );
}
