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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { SessionSummary } from "./types";

/**
 * 侧栏会话项的操作菜单:重命名 / 归档 / 删除。
 *
 * 曾经会话只能建不能管:标题永远是第一句话,用久了侧栏只能靠搜索找;
 * 删不掉的会话还一直占着工作目录。
 */
export function SessionActions({
  session,
  onChanged,
  onRemoved,
}: {
  session: SessionSummary;
  /** 标题等字段改了:刷新列表。 */
  onChanged: () => void;
  /** 会话从列表里消失(归档或删除):若正打开着,调用方要切走。 */
  onRemoved: (id: string) => void;
}) {
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [title, setTitle] = useState(session.title ?? "");
  const [busy, setBusy] = useState(false);
  const label = session.title || session.id.slice(0, 12);

  async function patch(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      await fetchJson(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(`操作失败:${errorText(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!title.trim()) return;
    if (await patch({ title }, "已重命名")) {
      setDialog(null);
      onChanged();
    }
  }

  async function archive() {
    if (await patch({ archived: true }, "已归档")) onRemoved(session.id);
  }

  async function remove() {
    setBusy(true);
    try {
      await fetchJson(`/api/sessions/${session.id}`, { method: "DELETE" });
      toast.success("会话已删除");
      setDialog(null);
      onRemoved(session.id);
    } catch (e) {
      toast.error(`删除失败:${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`会话操作:${label}`}>
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(session.title ?? "");
              setDialog("rename");
            }}
          >
            <Pencil />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archive()}>
            <Archive />
            归档
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <Input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="会话标题"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !title.trim()}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话「{label}」?</DialogTitle>
            <DialogDescription>
              正在运行的任务会被停止,工作目录里的文件会一起删除,且无法恢复。
              用量与计费记录会保留。只想从列表里收起来的话,用「归档」。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
