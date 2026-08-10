"use client";

import { Button } from "@/components/ui/button";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

/**
 * 路由级错误兜底。
 *
 * 【为什么必须有】没有这个文件时,页面组件一抛错,用户在生产环境看到的是
 * Next 自带的一句英文 "Application error: a client-side exception has occurred",
 * 既不知道发生了什么,也没有任何可做的下一步 —— 只能自己刷新或关掉。
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 生产环境用户看不到堆栈,至少让控制台留一份,便于对着 digest 排查
    console.error("[route error]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="size-8 text-destructive" />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold">这个页面出错了</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          你的数据没有丢失。可以先重试;如果一直失败,把下面这行编号告诉维护者。
        </p>
      </div>

      {/* digest 是 Next 给这次错误的服务端编号,比让用户复述现象靠谱得多 */}
      <code className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
        {error.digest ?? error.message.slice(0, 120) ?? "unknown"}
      </code>

      <div className="flex items-center gap-2">
        <Button onClick={reset} size="sm">
          <RotateCcw className="size-3.5" />
          重试
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            <Home className="size-3.5" />
            回工作台
          </Link>
        </Button>
      </div>
    </main>
  );
}
