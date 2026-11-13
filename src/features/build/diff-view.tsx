"use client";

// 差异展示(原型 .diff):每处改动标「新增 / 删除 / 修改」,长文本给行级差异(只显示改动行及上下各一行)。
// 设计器的待确认改动、差异与保存弹层、版本对比共用。

import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { changeLabel, changeRows } from "./design-sections";

const KIND = {
  added: { text: "新增", cls: "bg-success-soft text-success-text" },
  removed: { text: "删除", cls: "bg-destructive-soft text-destructive" },
  changed: { text: "修改", cls: "bg-warning-soft text-warning-text" },
} as const;

function Line({ op, text }: { op: "add" | "del" | "same"; text: string }) {
  return (
    <div
      className={cn(
        "px-3 py-[3px] font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]",
        op === "add" && "bg-[#EDF4EE] text-[#245437]",
        op === "del" && "bg-[#FAEDEA] text-[#8F3423] line-through",
        op === "same" && "text-muted-foreground",
      )}
    >
      {op === "add" ? "+ " : op === "del" ? "- " : "  "}
      {text}
    </div>
  );
}

export function KindTag({ kind }: { kind: SnapshotChange["kind"] }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-[10px] px-[7px] text-xs font-semibold",
        KIND[kind].cls,
      )}
    >
      {KIND[kind].text}
    </span>
  );
}

export function ChangeBlock({ c }: { c: SnapshotChange }) {
  const { rows, lineCount, long } = changeRows(c);
  const [open, setOpen] = useState(false);
  const folded = long && !open;
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line-soft bg-[#FBFAF7] px-3 py-2 text-xs text-muted-foreground">
        <KindTag kind={c.kind} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{changeLabel(c.path)}</span>
      </div>
      <div
        className={cn(
          folded &&
            "relative max-h-[220px] overflow-hidden after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-12 after:bg-gradient-to-t after:from-card after:to-transparent",
        )}
      >
        {rows.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 行没有稳定 ID,顺序不变
          <Line key={i} op={l.op} text={l.text} />
        ))}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-center gap-1 border-t border-line-soft px-3 py-1.5 text-xs text-muted-foreground hover:bg-[#F6F4EF] hover:text-foreground max-md:min-h-11"
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? "收起" : `展开全部（共 ${lineCount} 行）`}
        </button>
      )}
    </div>
  );
}

export function DiffList({
  changes,
  className,
  empty = "没有差异",
}: {
  changes: SnapshotChange[];
  className?: string;
  empty?: string;
}) {
  if (changes.length === 0) return <p className="m-0 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className={cn("overflow-hidden rounded-[14px] border border-border bg-card", className)}>
      {changes.map((c) => (
        <ChangeBlock key={`${c.kind}:${c.path}`} c={c} />
      ))}
    </div>
  );
}

/** 新增 n、删除 n、修改 n */
export function DiffCounts({ changes }: { changes: SnapshotChange[] }) {
  const n = (k: SnapshotChange["kind"]) => changes.filter((c) => c.kind === k).length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      {(["added", "removed", "changed"] as const).map((k) => (
        <span key={k} className="flex items-center gap-1">
          <KindTag kind={k} />
          {n(k)}
        </span>
      ))}
    </div>
  );
}
