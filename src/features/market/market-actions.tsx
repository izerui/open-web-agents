"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { Play, Terminal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

export function MarketActions({ agentId }: { agentId: string }) {
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      // 再核对上架状态;真正的使用权限仍由会话入口复核。
      await fetchJson(`/api/market/${encodeURIComponent(agentId)}`);
      const result = await fetchJson<{ session: { id: string } }>("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, versionMode: "published" }),
      });
      router.push(`/?session=${encodeURIComponent(result.session.id)}`);
    } catch (error) {
      toast.error(`创建会话失败：${errorText(error)}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onClick={() => void start()}>
        <Play className="size-4" />
        {busy ? "创建中…" : "立即使用"}
      </Button>
      <Button size="sm" variant="outline" asChild>
        <Link href={`/settings/keys?agent=${encodeURIComponent(agentId)}`}>
          <Terminal className="size-4" />
          API 接入
        </Link>
      </Button>
    </div>
  );
}
