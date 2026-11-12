import { cn } from "@/lib/utils";
import { Check, Minus, X } from "lucide-react";

/** 原型里的细环转圈(运行中、读取中)。纯装饰,状态文字由旁边的字给出。 */
export function Spin({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-[#D9D5CB] border-t-foreground motion-reduce:animate-none",
        className,
      )}
    />
  );
}

export type CallState = "ok" | "error" | "running" | "unknown";

/** 工具调用的状态图标:成功绿勾、失败红叉、进行中转圈、没收到结果的短横。 */
export function CallStateIcon({ state }: { state: CallState }) {
  if (state === "ok") return <Check className="size-[15px] text-success" strokeWidth={2.2} />;
  if (state === "error")
    return <X className="size-[15px] text-destructive" strokeWidth={2.2} aria-label="失败" />;
  if (state === "running") return <Spin className="size-3.5 border-[1.5px]" />;
  return <Minus className="size-[15px] text-muted-foreground" aria-label="没有收到结果" />;
}

export function callStateOf(
  call: { result?: { isError: boolean } },
  turnRunning: boolean,
): CallState {
  if (call.result) return call.result.isError ? "error" : "ok";
  // 没有结果:这一轮还在跑就是进行中;已经结束还没结果,说明结果没回传(中断、超时)
  return turnRunning ? "running" : "unknown";
}
