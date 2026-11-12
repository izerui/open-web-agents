"use client";

// 删除智能体:要输入智能体 ID 才能删(原型同款)。页头「更多」与发布阶段的危险区共用。

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { notifyAgentCatalogChanged } from "@/lib/agent-catalog";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { inputMono } from "./ui";

export function useDeleteAgent(agentId: string | null, name: string) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const match = Boolean(agentId) && typed.trim() === agentId;

  async function remove() {
    if (!agentId || !match) return;
    setBusy(true);
    try {
      await fetchJson(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
      notifyAgentCatalogChanged();
      toast.success(`已删除「${name}」`);
      setOpen(false);
      // 请求期间已经切到别的智能体:不再把页面带回工作室
      if (alive.current) router.push("/agents");
    } catch (e) {
      toast.error(`删除失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除「{name}」？</DialogTitle>
          <DialogDescription>
            删除后：接口调用、分享立即失效，绑定它的 API Key
            也调不通了；历史会话与运行记录保留。此操作不能在界面上撤销。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void remove();
          }}
          className="flex flex-col gap-1.5"
        >
          <label htmlFor="delete-agent-id" className="text-sm">
            输入智能体 ID <b className={inputMono}>{agentId}</b> 确认删除
          </label>
          <Input
            id="delete-agent-id"
            className={inputMono}
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={agentId ?? ""}
          />
          {typed.trim() !== "" && !match && (
            <span className="text-xs text-destructive">ID 不一致</span>
          )}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="destructive" disabled={!match || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              删除智能体
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return {
    ask: () => {
      setTyped("");
      setOpen(true);
    },
    dialog,
  };
}
