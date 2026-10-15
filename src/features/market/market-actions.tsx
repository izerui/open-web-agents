"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { Copy, Play, Terminal } from "lucide-react";
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

  async function cloneAgent() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await fetchJson<{ agent: { id: string; name: string } }>(
        `/api/agents/${encodeURIComponent(agentId)}/clone`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      toast.success(`已克隆为「${result.agent.name}」`);
      router.push(`/agents?id=${encodeURIComponent(result.agent.id)}`);
    } catch (error) {
      toast.error(`克隆失败：${errorText(error)}`);
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
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void cloneAgent()}>
        <Copy className="size-4" />
        克隆到我的智能体
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
