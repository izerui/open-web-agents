"use client";

import { cn } from "@/lib/utils";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { shortOrderId } from "./order-number";

/** 订单短号:显示前 8 位大写,悬停看完整编号,旁边的按钮复制完整编号。用户侧与管理端共用 */
export function OrderNo({ id, className }: { id: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}>
      <span className="font-mono" title={id}>
        {shortOrderId(id)}
      </span>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground max-sm:size-11"
        aria-label={`复制完整订单号 ${id}`}
        title="复制完整订单号"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(id).then(
            () => toast.success("已复制完整订单号"),
            () => toast.error("复制失败，请手动选中订单号"),
          );
        }}
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  );
}
