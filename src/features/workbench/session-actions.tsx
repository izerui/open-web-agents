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
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
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
  running = false,
  onChanged,
  onRemoved,
  className,
}: {
  session: SessionSummary;
  /** 这个会话正在运行(删除确认里要明确说会停止) */
  running?: boolean;
  className?: string;
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
      toast.error(`操作失败：${errorText(e)}`);
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
    if (await patch({ archived: true }, `已归档「${label}」,可在左下角「已归档」里恢复`)) {
      onRemoved(session.id);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await fetchJson(`/api/sessions/${session.id}`, { method: "DELETE" });
      toast.success("会话已删除");
      setDialog(null);
      onRemoved(session.id);
    } catch (e) {
      toast.error(`删除失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`会话操作：${label}`}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-[#E6E3DB] hover:text-foreground data-[state=open]:bg-[#E6E3DB] max-md:size-11 [&_svg]:size-4",
              className,
            )}
          >
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="min-w-[180px]">
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
            <DialogDescription className="sr-only">给这个会话起一个好找的名字</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <label
              htmlFor={`rename-${session.id}`}
              className="mb-1.5 block text-[13px] text-muted-foreground"
            >
              会话名
            </label>
            <Input
              id={`rename-${session.id}`}
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
            <DialogTitle>删除这个会话?</DialogTitle>
            <DialogDescription>「{label}」将被永久删除，不能恢复：</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-[1.8] text-muted-foreground">
            {running ? (
              <li className="font-semibold text-destructive">正在运行的任务会被停止</li>
            ) : (
              <li>如果有运行中的任务，会先停止</li>
            )}
            <li>会话的工作目录和里面的文件会被删除</li>
            <li>用量与计费记录保留，仍可在「积分与套餐」里查到</li>
            <li>只想从列表里收起来的话，用「归档」</li>
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
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
