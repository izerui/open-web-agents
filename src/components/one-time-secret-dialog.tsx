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
import { Copy } from "lucide-react";
import { toast } from "sonner";

/** 只显示一次的密钥 / 初始密码。关掉之后无法再查看。 */
export function OneTimeSecretDialog({
  title,
  description,
  secret,
  onClose,
}: {
  title: string;
  description: string;
  secret: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <code className="block break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
          {secret}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(secret ?? "")
                .then(() => toast.success("已复制"))
                .catch(() => toast.error("复制失败,请手动选择文本"))
            }
          >
            <Copy className="size-3.5" />
            复制
          </Button>
          <Button onClick={onClose}>我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
