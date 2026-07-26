"use client";

import { useCallback, useEffect, useState } from "react";
import type { FileNode, FilePreview } from "./types";

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
    return <p className="p-4 text-xs opacity-40">发送消息后创建会话工作空间</p>;
  }

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-black/10 border-b px-3 py-2 dark:border-white/15">
        <span className="font-medium text-xs">工作空间</span>
        <span className="truncate font-mono text-xs opacity-50">/{dir}</span>
        <button
          type="button"
          className="ml-auto text-xs opacity-60 hover:opacity-100"
          onClick={() => void loadDir(dir)}
        >
          刷新
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-3 text-red-600 text-xs">{error}</p>}

        {parentDir !== null && (
          <button
            type="button"
            className="block w-full px-3 py-1 text-left font-mono text-xs opacity-60 hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => void loadDir(parentDir)}
          >
            ../
          </button>
        )}

        {nodes.length === 0 && !error && (
          <p className="p-3 text-xs opacity-40">(空目录 —— 让 agent 生成点东西)</p>
        )}

        {nodes.map((n) => (
          <button
            key={n.path}
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => (n.type === "dir" ? void loadDir(n.path) : void openFile(n))}
          >
            <span className="text-xs">{n.type === "dir" ? "📁" : "📄"}</span>
            <span className="flex-1 truncate font-mono text-xs">{n.name}</span>
            <span className="text-xs opacity-40">{formatSize(n.size)}</span>
          </button>
        ))}
      </div>

      {preview && (
        <div className="flex max-h-[45%] min-h-0 flex-col border-black/10 border-t dark:border-white/15">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="truncate font-mono text-xs">{preview.path}</span>
            <a
              className="ml-auto text-xs underline opacity-60 hover:opacity-100"
              href={`/api/sessions/${sessionId}/files?download=${encodeURIComponent(preview.path)}`}
            >
              下载
            </a>
            <button
              type="button"
              className="text-xs opacity-60 hover:opacity-100"
              onClick={() => setPreview(null)}
            >
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
            {preview.text === null ? (
              <p className="text-xs opacity-50">
                {preview.mime} · {formatSize(preview.size)} —— 二进制文件,请下载查看
              </p>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs">{preview.text}</pre>
            )}
            {preview.truncated && <p className="pt-2 text-xs opacity-50">…内容过长已截断</p>}
          </div>
        </div>
      )}
    </div>
  );
}
