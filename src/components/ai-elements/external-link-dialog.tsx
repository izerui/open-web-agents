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
import type { LinkSafetyModalProps } from "streamdown";
import { toast } from "sonner";
import { externalLinkTarget } from "./external-link";

/**
 * 对话正文里点外链时的中文确认框（chat N1）。替换 Streamdown 自带的英文确认框：
 * 用 Dialog 画在页面最上层（不画在对话流里），写明要去的域名，给「打开链接 / 复制链接 / 取消」。
 */
export function ExternalLinkDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const target = externalLinkTarget(url);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("已复制链接");
      onClose();
    } catch {
      toast.error("复制失败，请手动选中链接复制");
    }
  };
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>打开外部链接？</DialogTitle>
          <DialogDescription>
            将在新标签页打开 <span className="font-medium text-foreground">{target}</span>
            ，这个网站不属于本平台，请确认链接可信。
          </DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-[13px] text-muted-foreground">
          {url}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant="outline" onClick={() => void copy()}>
            复制链接
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            打开链接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
