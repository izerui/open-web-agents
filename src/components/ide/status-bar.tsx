"use client";

import { fetchJson } from "@/lib/fetch-json";
import { creditsBalance } from "@/lib/modules/billing/domain/credits-display";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useEffect, useState } from "react";

/** 浏览器网络状态。服务端掉线由各页面自己的请求报错,这里只回答"我这边断没断网"。 */
function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

/**
 * 可用积分。
 *
 * 【为什么只拉一次】状态栏是"瞄一眼"的地方,不是对账的地方 —— 运行结束后余额会变,
 * 但精确数字在积分账户页;这里每次换页(外壳重新挂载)刷新一次就够了。
 * 拿不到(没登录、接口出错)就不显示,不在状态栏里报错。
 */
function useBalance(enabled: boolean): string | null {
  const [balance, setBalance] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchJson<{ balance: { availableMicroCredits: string } }>("/api/billing?limit=1")
      .then((r) => alive && setBalance(creditsBalance(r.balance.availableMicroCredits)))
      .catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return balance;
}

/** 状态栏里的一段。分段之间不画竖线,靠间距分开 —— 和 IDE 状态栏一致。 */
export function StatusItem({
  className,
  children,
  title,
}: {
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className={cn("flex min-w-0 items-center gap-1.5 truncate", className)}>
      {children}
    </span>
  );
}

/**
 * 底部状态栏:连接、页面自己的信息(工作台放运行状态和模型)、积分、账号。
 *
 * 【为什么要有】改造前积分余额要进积分账户页才看得到,当前模型和计费单价挤在
 * 对话标题栏里、窄屏下直接隐藏。这些是"随时瞄一眼"的信息,IDE 的固定位置是状态栏。
 */
export function StatusBar({ children }: { children?: React.ReactNode }) {
  const online = useOnline();
  const { me } = useMe();
  const balance = useBalance(Boolean(me?.user));

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-sidebar px-3 text-xs text-muted-foreground">
      <StatusItem>
        <span className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-destructive")} />
        {online ? "已连接" : "网络已断开"}
      </StatusItem>
      {children}
      <span className="flex-1" />
      {balance !== null && (
        <Link
          href="/settings/billing"
          className="shrink-0 hover:text-foreground"
          title="可用积分,点击查看积分账户"
        >
          积分 <span className="font-mono text-foreground/80">{balance}</span>
        </Link>
      )}
      {me?.user && (
        <StatusItem className="hidden shrink-0 sm:flex">
          {me.user.role === "admin" ? "管理员" : me.user.email}
        </StatusItem>
      )}
    </footer>
  );
}
