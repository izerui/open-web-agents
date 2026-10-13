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
import { type ReactNode, useState } from "react";

export interface ConfirmRequest {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * 应用内的确认对话框,替代 window.confirm。
 * window.confirm 样式与产品不一致、会阻塞整个页面、在嵌入的 iframe 里还可能被宿主禁用。
 *
 * 用法:const confirm = useConfirm(); confirm.ask({...}); 并渲染 {confirm.dialog}
 */
export function useConfirm() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const dialog = (
    <Dialog open={req !== null} onOpenChange={(o) => !o && !busy && setReq(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          {req?.description && <DialogDescription>{req.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setReq(null)}>
            取消
          </Button>
          <Button
            variant={req?.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              if (!req) return;
              setBusy(true);
              try {
                await req.onConfirm();
              } finally {
                setBusy(false);
                setReq(null);
              }
            }}
          >
            {req?.confirmLabel ?? "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { ask: setReq, dialog };
}
