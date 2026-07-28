"use client";

import { useCallback, useEffect, useState } from "react";
import type { FileNode, FilePreview } from "./types";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  RefreshCw,
  Download,
  X,
  Folder,
  FileText,
  ChevronLeft,
  FolderOpen,
  FileWarning,
} from "lucide-react";

function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 工作空间文件面板:目录浏览 + 预览。
 * 每轮运行结束后由父组件触发 refreshKey 变化重新拉取,让新产物立刻可见。
 */
export function FilePanel({
  sessionId,
  refreshKey,
}: {
  sessionId: string | null;
  refreshKey: number;
}) {
  const [dir, setDir] = useState("");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (target: string) => {
      if (!sessionId) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/files?dir=${encodeURIComponent(target)}`,
        );
        const data = (await res.json()) as { nodes?: FileNode[]; error?: string };
        if (data.error) throw new Error(data.error);
        setNodes(data.nodes ?? []);
        setDir(target);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (sessionId) void loadDir("");
    else {
      setNodes([]);
      setPreview(null);
    }
  }, [sessionId, loadDir]);

  // 运行结束后刷新当前目录,展示新产物
  useEffect(() => {
    if (sessionId && refreshKey > 0) void loadDir(dir);
    // dir 变化由点击驱动,不应触发本 effect
  }, [refreshKey, sessionId, loadDir, dir]);

  async function openFile(node: FileNode) {
    if (!sessionId) return;
    const res = await fetch(
      `/api/sessions/${sessionId}/files?file=${encodeURIComponent(node.path)}`,
    );
    const data = (await res.json()) as { preview?: FilePreview; error?: string };
    if (data.preview) setPreview(data.preview);
    else setError(data.error ?? "预览失败");
  }

  const parentDir = dir ? dir.split("/").slice(0, -1).join("/") : null;

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <FolderOpen className="size-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">发送消息后创建会话工作空间</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-sm">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-xs">工作空间</span>
        <span className="truncate font-mono text-xs text-muted-foreground">/{dir}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={() => void loadDir(dir)}
          title="刷新"
        >
          <RefreshCw />
        </Button>
      </div>

      {/* 文件列表 */}
      <ScrollArea className="min-h-0 flex-1">
        {error && (
          <div className="flex items-center gap-2 p-3">
            <FileWarning className="size-4 shrink-0 text-destructive" />
            <p className="text-destructive text-xs">{error}</p>
          </div>
        )}

        {parentDir !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-mono text-muted-foreground"
            onClick={() => void loadDir(parentDir)}
          >
            <ChevronLeft className="size-4" />
            ../
          </Button>
        )}

        {nodes.length === 0 && !error && (
          <div className="flex flex-col items-center gap-1 p-4 text-center">
            <FolderOpen className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">(空目录 —— 让 agent 生成点东西)</p>
          </div>
        )}

        {nodes.map((n) => (
          <Button
            key={n.path}
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => (n.type === "dir" ? void loadDir(n.path) : void openFile(n))}
          >
            {n.type === "dir" ? (
              <Folder className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1 truncate text-left font-mono text-xs">{n.name}</span>
            {n.size !== undefined && (
              <Badge variant="ghost" className="shrink-0 text-muted-foreground">
                {formatSize(n.size)}
              </Badge>
            )}
          </Button>
        ))}
      </ScrollArea>

      {/* 文件预览面板 */}
      {preview && (
        <div className="flex max-h-[45%] min-h-0 flex-col border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs">{preview.path}</span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
                title="下载"
              >
                <a
                  href={`/api/sessions/${sessionId}/files?download=${encodeURIComponent(preview.path)}`}
                >
                  <Download />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setPreview(null)}
                title="关闭"
              >
                <X />
              </Button>
            </div>
          </div>
          <Separator />
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2">
            {preview.text === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileWarning className="size-4 shrink-0" />
                <span>
                  {preview.mime} · {formatSize(preview.size)} —— 二进制文件,请下载查看
                </span>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs">{preview.text}</pre>
            )}
            {preview.truncated && (
              <p className="pt-2 text-xs text-muted-foreground">…内容过长已截断</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
