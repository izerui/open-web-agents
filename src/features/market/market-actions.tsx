"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { chatHref } from "@/features/explore/explore-logic";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { agentHref } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { Copy, MessageSquare, Terminal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * 用一个智能体新建会话。
 * - market:市场入口。先确认它仍在市场上(下架了就别建会话),再锁定发布版
 * - own:自己的智能体(探索页推荐里的「你的智能体」)。不传版本模式,作者跟随草稿,与工作台一致
 */
export async function startAgentSession(
  agentId: string,
  mode: "market" | "own" = "market",
): Promise<string> {
  if (mode === "market") await fetchJson(`/api/market/${encodeURIComponent(agentId)}`);
  const result = await fetchJson<{ session: { id: string } }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode === "market" ? { agentId, versionMode: "published" } : { agentId }),
  });
  return result.session.id;
}

/** 立即使用 / 克隆 的进行中状态与动作;同一时刻只允许一个请求在路上。 */
export function useAgentActions() {
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState<"start" | "clone" | null>(null);

  async function guard(kind: "start" | "clone", fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    try {
      await fn();
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return {
    busy,
    start: (agentId: string, opts: { mode?: "market" | "own"; question?: string } = {}) =>
      guard("start", async () => {
        try {
          const id = await startAgentSession(agentId, opts.mode);
          router.push(chatHref(id, opts.question));
        } catch (error) {
          toast.error(`创建会话失败：${errorText(error)}`);
        }
      }),
    clone: (agentId: string) =>
      guard("clone", async () => {
        try {
          const result = await fetchJson<{ agent: { id: string; name: string } }>(
            `/api/agents/${encodeURIComponent(agentId)}/clone`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
          );
          toast.success(`已克隆为「${result.agent.name}」`);
          router.push(agentHref({ id: result.agent.id }));
        } catch (error) {
          toast.error(`克隆失败：${errorText(error)}`);
        }
      }),
  };
}

/** 克隆前的确认:说清复制了什么、之后不会同步。 */
export function CloneDialog({
  open,
  onOpenChangeAction,
  name,
  version,
  busy,
  onConfirmAction,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
  name: string;
  version?: number | null;
  busy: boolean;
  onConfirmAction: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChangeAction}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>克隆「{name}」</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-[#3C3A35]">
            把{version ? `发布版 v${version} ` : "当前发布版"}的配置复制成你名下的新草稿。
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          提示词、能力、契约一并复制；原作者之后的更新不会同步过来。克隆后进入编排，可以直接改。
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChangeAction(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={onConfirmAction} disabled={busy}>
            {busy ? "克隆中…" : "克隆并编辑"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 市场智能体的三个操作:立即使用 / 克隆 / API 接入。
 * layout=card 是卡片底部的一排小按钮;stack 是详情页右侧竖排的大按钮。
 */
export function MarketActions({
  agentId,
  name,
  version,
  layout = "card",
}: {
  agentId: string;
  name: string;
  version?: number | null;
  layout?: "card" | "stack";
}) {
  const { busy, start, clone } = useAgentActions();
  const [confirm, setConfirm] = useState(false);
  const stack = layout === "stack";
  const size = stack ? "lg" : "sm";
  const mobile = "max-md:h-11";

  return (
    <div
      className={cn(
        "flex gap-2",
        stack ? "flex-col max-md:flex-row max-md:flex-wrap" : "flex-wrap",
      )}
    >
      <Button
        size={size}
        className={cn(mobile, stack && "max-md:flex-1")}
        disabled={busy !== null}
        onClick={() => void start(agentId)}
      >
        {stack && <MessageSquare />}
        {busy === "start" ? "创建中…" : "立即使用"}
      </Button>
      <Button
        size={size}
        variant="outline"
        className={cn(mobile, stack && "max-md:flex-1")}
        disabled={busy !== null}
        onClick={() => setConfirm(true)}
      >
        {stack && <Copy />}
        {stack ? "克隆到我的智能体" : "克隆"}
      </Button>
      <Button
        size={size}
        variant="outline"
        className={cn(mobile, stack && "max-md:flex-1")}
        asChild
      >
        <Link href={agentHref({ id: agentId, stage: "access" })}>
          {stack && <Terminal />}
          API 接入
        </Link>
      </Button>
      <CloneDialog
        open={confirm}
        onOpenChangeAction={setConfirm}
        name={name}
        version={version}
        busy={busy === "clone"}
        onConfirmAction={() => void clone(agentId).then(() => setConfirm(false))}
      />
    </div>
  );
}
