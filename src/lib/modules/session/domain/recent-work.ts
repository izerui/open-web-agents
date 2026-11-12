// 探索首页「你的 AI 同事正在工作」(gaps.md A2):最近会话的状态与交付物。
//
// 现有产品没有「交付物」概念。这里的做法:最近一次运行成功、且工作区里有它开始之后
// 写出的文件,就算「成果已交付」,文件卡显示最新的那个;没有文件就是「已回复」。

import type { FileNode } from "@/lib/modules/artifacts/ports";
import type { RunState } from "@/lib/shared";

export type WorkStatus = "running" | "delivered" | "replied" | "failed" | "cancelled" | "idle";

export function workStatus(
  lastRun: RunState | undefined,
  file: { name: string } | null,
): WorkStatus {
  switch (lastRun) {
    case "pending":
    case "running":
      return "running";
    case "success":
      return file ? "delivered" : "replied";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}

export interface DeliveredFile {
  name: string;
  path: string;
  size?: number;
  mtime?: number;
}

/** 工作区根目录下最近修改的文件;隐藏文件(SDK 的 .claude 等)与目录不算。 */
export function latestFile(
  nodes: readonly FileNode[],
  opts: { since?: number } = {},
): DeliveredFile | null {
  let best: FileNode | null = null;
  for (const n of nodes) {
    if (n.type !== "file" || n.name.startsWith(".")) continue;
    if (opts.since !== undefined && (n.mtime ?? 0) < opts.since) continue;
    if (!best || (n.mtime ?? 0) > (best.mtime ?? 0)) best = n;
  }
  return best ? { name: best.name, path: best.path, size: best.size, mtime: best.mtime } : null;
}
