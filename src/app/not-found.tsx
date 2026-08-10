import { Button } from "@/components/ui/button";
import { Compass, Home } from "lucide-react";
import Link from "next/link";

/** 404。没有它的话,访问不存在的路径会落到 Next 自带的英文页面上。 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <Compass className="size-8 text-muted-foreground/50" />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold">没有这个页面</h1>
        <p className="text-sm text-muted-foreground">链接可能过期了,或者地址打错了。</p>
      </div>
      <Button asChild size="sm">
        <Link href="/">
          <Home className="size-3.5" />
          回工作台
        </Link>
      </Button>
    </main>
  );
}
