"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileNode, FilePreview } from "./types";

import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Download, FileText, FileWarning, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import type { BundledLanguage } from "shiki";

/**
 * 扩展名 → shiki 语言。
 * 表里没有的一律回落到 text —— CodeBlock 内部对未加载的语言也会再兜一次底,
 * 所以这里不认识的扩展名不会导致高亮失败,只是没有着色。
 */
const EXT_LANGUAGE: Record<string, string> = {
  bash: "bash",
  c: "c",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

function guessLanguage(path: string): BundledLanguage {
  const name = path.split("/").pop() ?? "";
  // 无扩展名但有约定俗成的文件名
  if (/^dockerfile$/i.test(name)) return "dockerfile" as BundledLanguage;
  if (/^makefile$/i.test(name)) return "make" as BundledLanguage;
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
  return (ext ? (EXT_LANGUAGE[ext] ?? "text") : "text") as BundledLanguage;
}

function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 根目录在 API 里是空字符串,但 Set/Map 的 key 用空串容易看走眼,这里统一。 */
const ROOT = "";

/**
 * 工作空间文件面板:懒加载树 + 预览。
 *
 * 【为什么是懒加载而不是一次拉全树】工作空间是 agent 现写出来的,
 * 可能有 node_modules 这种几万个文件的目录,一次性拉全树会把接口和界面都拖垮。
 * 所以每个目录在【第一次展开时】才去拉它那一层,拉过的存在 dirs 里不重复拉。
 */
export function FilePanel({
  sessionId,
  refreshKey,
}: {
  sessionId: string | null;
  refreshKey: number;
}) {
  /** 目录路径 → 该目录下的一层子节点。没有条目 = 还没拉过。 */
  const [dirs, setDirs] = useState<Map<string, FileNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 刷新时要遍历"当前已拉过的目录",但那个 effect 不该因为 dirs 变化就重跑
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  /** 按路径找回节点 —— 需要知道点中的是文件还是目录。 */
  const findNode = useCallback(
    (path: string): FileNode | undefined => {
      for (const nodes of dirs.values()) {
        const hit = nodes.find((n) => n.path === path);
        if (hit) return hit;
      }
      return undefined;
    },
    [dirs],
  );

  const loadDir = useCallback(
    async (target: string) => {
      if (!sessionId) return;
      setLoading((s) => new Set(s).add(target));
      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/files?dir=${encodeURIComponent(target)}`,
        );
        const data = (await res.json()) as { nodes?: FileNode[]; error?: string };
        if (data.error) throw new Error(data.error);
        setDirs((m) => new Map(m).set(target, data.nodes ?? []));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading((s) => {
          const next = new Set(s);
          next.delete(target);
          return next;
        });
      }
    },
    [sessionId],
  );

  // 换会话:清空整棵树,重新从根拉
  useEffect(() => {
    setDirs(new Map());
    setExpanded(new Set());
    setSelected(undefined);
    setPreview(null);
    setError(null);
    if (sessionId) void loadDir(ROOT);
  }, [sessionId, loadDir]);

  /**
   * 运行结束后刷新。
   *
   * 【为什么要重拉所有已展开的目录】新产物可能落在任意一层。
   * 只刷新根目录的话,用户展开着的子目录会一直显示旧内容 —— 看起来像 agent 什么都没写。
   */
  useEffect(() => {
    if (!sessionId || refreshKey === 0) return;
    for (const dir of [ROOT, ...dirsRef.current.keys()]) void loadDir(dir);
    // 只在 refreshKey 变化时重拉 —— 展开新目录由展开动作自己负责
  }, [refreshKey, sessionId, loadDir]);

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      // 新展开且没拉过的目录,现在拉
      for (const path of next) {
        if (!expanded.has(path) && !dirs.has(path)) void loadDir(path);
      }
      setExpanded(next);
    },
    [expanded, dirs, loadDir],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      setSelected(path);
      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/files?file=${encodeURIComponent(path)}`,
        );
        const data = (await res.json()) as { preview?: FilePreview; error?: string };
        if (data.preview) setPreview(data.preview);
        else setError(data.error ?? "预览失败");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  const refreshAll = useCallback(() => {
    for (const dir of [ROOT, ...dirs.keys()]) void loadDir(dir);
  }, [dirs, loadDir]);

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <FolderOpen className="size-8 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">发送消息后创建会话工作空间</p>
      </div>
    );
  }

  /** 递归渲染一层。目录的子节点在展开后由同一个组件继续渲染下一层。 */
  function renderLevel(dir: string): React.ReactNode {
    const nodes = dirs.get(dir);

    if (nodes === undefined) {
      return loading.has(dir) ? (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          载入中…
        </div>
      ) : null;
    }

    if (nodes.length === 0) {
      return <p className="px-2 py-1 text-xs text-muted-foreground/60">(空)</p>;
    }

    return nodes.map((n) =>
      n.type === "dir" ? (
        <FileTreeFolder key={n.path} name={n.name} path={n.path}>
          {renderLevel(n.path)}
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={n.path} name={n.name} path={n.path}>
          <span className="size-4 shrink-0" />
          <FileTreeIcon>
            <FileText className="size-4 text-muted-foreground" />
          </FileTreeIcon>
          <FileTreeName className="flex-1 text-xs">{n.name}</FileTreeName>
          {n.size !== undefined && (
            <Badge variant="ghost" className="shrink-0 text-[10px] text-muted-foreground">
              {formatSize(n.size)}
            </Badge>
          )}
        </FileTreeFile>
      ),
    );
  }

  const rootNodes = dirs.get(ROOT);

  return (
    <div className="flex h-full flex-col text-sm">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">工作空间</span>
        {loading.size > 0 && <Spinner className="size-3 text-muted-foreground" />}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={refreshAll}
          title="刷新"
        >
          <RefreshCw />
        </Button>
      </div>

      {/* 文件树 */}
      <ScrollArea className="min-h-0 flex-1">
        {error && (
          <div className="flex items-start gap-2 p-3">
            <FileWarning className="size-4 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {rootNodes?.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-1 p-6 text-center">
            <FolderOpen className="size-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">空目录</p>
            <p className="text-[11px] text-muted-foreground/60">让 agent 生成点东西</p>
          </div>
        ) : (
          <FileTree
            className="rounded-none border-0 bg-transparent"
            expanded={expanded}
            onExpandedChange={handleExpandedChange}
            onSelect={(path) => {
              // 目录的展开收起由箭头负责,点名字只对文件有意义。
              // 这里必须查节点类型:dirs 只装【已展开过】的目录,
              // 拿它判断会把没展开过的目录当成文件送去预览。
              if (findNode(path)?.type === "file") void openFile(path);
            }}
            selectedPath={selected}
          >
            {renderLevel(ROOT)}
          </FileTree>
        )}
      </ScrollArea>

      {/* 文件预览面板 */}
      {preview && (
        <div className="flex max-h-[45%] min-h-0 flex-col border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs">{preview.path}</span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" asChild title="下载">
                <a
                  href={`/api/sessions/${sessionId}/files?download=${encodeURIComponent(preview.path)}`}
                >
                  <Download />
                </a>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setPreview(null)} title="关闭">
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
              <CodeBlock
                className="text-xs"
                code={preview.text}
                language={guessLanguage(preview.path)}
                showLineNumbers
              >
                <CodeBlockCopyButton />
              </CodeBlock>
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
