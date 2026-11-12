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
import { chatHref, startedText } from "@/features/explore/explore-logic";
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
): Promise<{ id: string; name?: string; version?: number | null }> {
  const market =
    mode === "market"
      ? (
          await fetchJson<{ agent: { name: string; publishedVersion?: number | null } }>(
            `/api/market/${encodeURIComponent(agentId)}`,
          )
        ).agent
      : null;
  const result = await fetchJson<{ session: { id: string } }>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode === "market" ? { agentId, versionMode: "published" } : { agentId }),
  });
  return { id: result.session.id, name: market?.name, version: market?.publishedVersion };
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
    /**
     * name / version:提示「已用「X」vN 新建会话」用。市场入口以接口返回的发布版为准,
     * 自己的智能体(不锁版本)由调用方给名字。
     */
    start: (
      agentId: string,
      opts: {
        mode?: "market" | "own";
        question?: string;
        name?: string;
        version?: number | null;
      } = {},
    ) =>
      guard("start", async () => {
        try {
          const s = await startAgentSession(agentId, opts.mode);
          toast.success(
            startedText(
              s.name ?? opts.name,
              opts.mode === "own" ? null : (s.version ?? opts.version),
            ),
          );
          router.push(chatHref(s.id, opts.question));
        } catch (error) {
          toast.error(`创建会话失败：${errorText(error)}`);
        }
      }),
    clone: (agentId: string, name?: string) =>
      guard("clone", async () => {
        try {
          const result = await fetchJson<{ agent: { id: string; name: string } }>(
            `/api/agents/${encodeURIComponent(agentId)}/clone`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
          );
          toast.success(cloneDoneText(name, result.agent.name));
          router.push(agentHref({ id: result.agent.id }));
        } catch (error) {
          toast.error(`克隆失败：${errorText(error)}`);
        }
      }),
  };
}

/** 克隆成功的提示(原型:已克隆「X」到我的智能体);不知道原名时说新草稿的名字 */
export function cloneDoneText(sourceName: string | undefined, copyName: string): string {
  return sourceName ? `已克隆「${sourceName}」到我的智能体` : `已克隆为「${copyName}」`;
}

/** 克隆前的确认:说清复制了什么、新草稿叫什么、之后不会同步。 */
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
            把{version ? `发布版 v${version} ` : "当前发布版"}
            复制成你名下的新草稿「{name}（副本）」，ID 由系统新生成。
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>提示词、能力、契约和知识一并复制。</li>
          <li>密钥类变量不会复制，需要的话在新草稿里重新填写。</li>
          <li>原作者之后的更新不会同步过来。克隆后进入编排，可以直接改。</li>
        </ul>
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
        onConfirmAction={() => void clone(agentId, name).then(() => setConfirm(false))}
      />
    </div>
  );
}
