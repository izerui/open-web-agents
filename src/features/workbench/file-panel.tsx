"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileNode, FilePreview } from "./types";

import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Archive,
  Copy,
  Download,
  FileImage,
  FileText,
  FileWarning,
  FolderOpen,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import type { BundledLanguage } from "shiki";
import { toast } from "sonner";

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

function fileIconOf(name: string) {
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name))
    return <FileImage className="size-4 text-muted-foreground" />;
  if (/\.(py|js|ts|tsx|jsx|sh|log|json|sql|go|rs|java|rb|php)$/i.test(name))
    return <SquareTerminal className="size-4 text-muted-foreground" />;
  return <FileText className="size-4 text-muted-foreground" />;
}

/** 工作目录路径条:路径、运行中实时刷新、手动刷新。 */
function PathBar({
  label,
  live = false,
  loading = false,
  onRefresh,
}: {
  label: string;
  live?: boolean;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="flex min-h-[45px] shrink-0 items-center gap-2 border-b border-line-soft px-4 py-2 text-[12.5px] whitespace-nowrap text-muted-foreground">
      工作目录
      <code className="min-w-0 truncate rounded-md bg-[#F4F2EC] px-1.5 py-0.5 font-mono text-[#3C3A35]">
        {label}
      </code>
      {live && (
        <span className="rounded-full bg-warning-soft px-2 text-xs leading-5 text-warning-text">
          运行中，实时刷新
        </span>
      )}
      {loading && <Spinner className="size-3.5" />}
      {onRefresh && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={onRefresh}
          title="刷新"
          aria-label="刷新工作空间"
        >
          <RefreshCw />
        </Button>
      )}
    </div>
  );
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
  live = false,
  onSuggestAction,
}: {
  sessionId: string | null;
  refreshKey: number;
  /** 当前会话正在运行:此时才需要轮询,产物在持续变化。 */
  live?: boolean;
  /** 空目录时的「让智能体生成点东西」:由页面决定怎么做(比如预填输入框) */
  onSuggestAction?: () => void;
}) {
  /** 目录路径 → 该目录下的一层子节点。没有条目 = 还没拉过。 */
  const [dirs, setDirs] = useState<Map<string, FileNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** HTML 产物默认渲染出来看效果,可切回源码。非 HTML 文件用不到这个开关。 */
  const [showRendered, setShowRendered] = useState(true);
  /** 避免轮询、手动刷新和展开动作同时重复请求同一目录。 */
  const inFlightRef = useRef(new Set<string>());
  /** 丢弃快速切换文件后才返回的旧预览请求。 */
  const previewSeqRef = useRef(0);
  /** 丢弃切换会话后才返回的旧目录请求。 */
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

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
      const requestSession = sessionId;
      const requestKey = `${requestSession}:${target}`;
      if (inFlightRef.current.has(requestKey)) return;
      inFlightRef.current.add(requestKey);
      setLoading((s) => new Set(s).add(target));
      try {
        const res = await fetch(
          `/api/sessions/${requestSession}/files?dir=${encodeURIComponent(target)}`,
          { cache: "no-store" },
        );
        // 曾经不看 res.ok:后端 500 时用户看到的是一句 JSON 解析报错
        const data = (await res.json().catch(() => ({}))) as { nodes?: FileNode[]; error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (sessionRef.current !== requestSession) return;
        const nodes = data.nodes ?? [];
        // 内容没变就不换 Map:每次都 new Map 会让整棵树跟着重渲染
        setDirs((m) =>
          JSON.stringify(m.get(target)) === JSON.stringify(nodes)
            ? m
            : new Map(m).set(target, nodes),
        );
        setError(null);
      } catch (e) {
        if (sessionRef.current === requestSession) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        inFlightRef.current.delete(requestKey);
        if (sessionRef.current === requestSession) {
          setLoading((s) => {
            const next = new Set(s);
            next.delete(target);
            return next;
          });
        }
      }
    },
    [sessionId],
  );

  // 换会话:清空整棵树,重新从根拉
  useEffect(() => {
    previewSeqRef.current += 1;
    setDirs(new Map());
    setExpanded(new Set());
    setLoading(new Set());
    setSelected(undefined);
    setPreview(null);
    setError(null);
    setPreviewError(null);
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
    for (const dir of new Set([ROOT, ...dirsRef.current.keys()])) void loadDir(dir);
    // 只在 refreshKey 变化时重拉 —— 展开新目录由展开动作自己负责
  }, [refreshKey, sessionId, loadDir]);

  /**
   * 运行中工作空间在持续变化:页面可见时低频刷新当前已经展示的层级,
   * 既能及时出现新文件,也不会递归扫描 node_modules 等大型目录。
   *
   * 只在运行中轮询 —— 曾经不论有没有在跑都每 2.5 秒重拉全部展开目录。
   * 不在跑的时候,运行结束那一刻的 refreshKey 刷新已经足够。
   */
  useEffect(() => {
    if (!sessionId || !live) return;
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const dir of new Set([ROOT, ...dirsRef.current.keys()])) void loadDir(dir);
    };
    const timer = window.setInterval(refreshVisible, 2_500);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [sessionId, loadDir, live]);

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
      const requestSession = sessionId;
      const requestSeq = ++previewSeqRef.current;
      setSelected(path);
      setPreview(null);
      setPreviewError(null);
      setShowRendered(true);
      try {
        const res = await fetch(
          `/api/sessions/${requestSession}/files?file=${encodeURIComponent(path)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as { preview?: FilePreview; error?: string };
        if (!res.ok || !data.preview) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (sessionRef.current !== requestSession || previewSeqRef.current !== requestSeq) return;
        setPreview(data.preview);
        setPreviewError(null);
      } catch (e) {
        if (sessionRef.current === requestSession && previewSeqRef.current === requestSeq) {
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [sessionId],
  );

  const refreshAll = useCallback(() => {
    for (const dir of new Set([ROOT, ...dirs.keys()])) void loadDir(dir);
  }, [dirs, loadDir]);

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col text-sm">
        <PathBar label="尚未创建" />
        <div className="px-6 py-10 text-center text-muted-foreground">
          <FolderOpen className="mx-auto size-7" />
          <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">还没有工作目录</p>
          <p>
            发出第一条消息后，会为这个会话创建独立的工作目录，上传的附件和智能体生成的文件都在这里。
          </p>
        </div>
      </div>
    );
  }

  /** 递归渲染一层。目录的子节点在展开后由同一个组件继续渲染下一层。 */
  function renderLevel(dir: string): React.ReactNode {
    const nodes = dirs.get(dir);

    if (nodes === undefined) {
      return loading.has(dir) ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5" />
          载入中…
        </div>
      ) : null;
    }

    if (nodes.length === 0) {
      return <p className="px-2 py-1.5 text-[13px] text-muted-foreground">（空）</p>;
    }

    return nodes.map((n) =>
      n.type === "dir" ? (
        <FileTreeFolder key={n.path} name={n.name} path={n.path}>
          {renderLevel(n.path)}
        </FileTreeFolder>
      ) : (
        <FileTreeFile
          key={n.path}
          name={n.name}
          path={n.path}
          className="min-h-8 rounded-lg hover:bg-[#F4F2EC]"
        >
          <span className="size-4 shrink-0" />
          <FileTreeIcon>{fileIconOf(n.name)}</FileTreeIcon>
          <FileTreeName className="flex-1 text-sm">{n.name}</FileTreeName>
          {n.size !== undefined && (
            <span className="shrink-0 pl-2 text-xs text-muted-foreground">
              {formatSize(n.size)}
            </span>
          )}
        </FileTreeFile>
      ),
    );
  }

  const rootNodes = dirs.get(ROOT);
  // HTML 与 Markdown 提供「预览 / 源码」切换,其余文件没有可渲染的形态
  const isHtml = preview?.mime === "text/html";
  const isMarkdown =
    preview !== null &&
    preview.text !== null &&
    (preview.mime === "text/markdown" || /\.(md|markdown)$/i.test(preview.path));
  const name = preview?.path.split("/").pop() ?? "";
  const fileUrl = (inline: boolean) =>
    `/api/sessions/${sessionId}/files?download=${encodeURIComponent(preview?.path ?? "")}${inline ? "&inline=1" : ""}`;
  const notFound = error !== null && /^not found$/i.test(error);

  return (
    <div className="flex h-full flex-col text-sm">
      <PathBar
        label={`workspaces/${sessionId.slice(0, 8)}`}
        live={live}
        loading={loading.size > 0}
        onRefresh={refreshAll}
      />

      {/* 文件树:有预览时收成上半截,把空间让给预览 */}
      <ScrollArea
        className={cn(
          "min-h-0",
          preview ? "max-h-[38%] shrink-0 border-b border-line-soft" : "flex-1",
        )}
      >
        {/*
          【为什么不直接把 error 甩出来】接口回的是 "not found" 这种给程序看的字符串,
          用户看到只会一头雾水。把最常见的一种翻译成人话,其余仍原样附在下面备查。
        */}
        {error ? (
          <div className="px-6 py-10 text-center text-muted-foreground">
            {notFound ? (
              <Archive className="mx-auto size-7" />
            ) : (
              <FileWarning className="mx-auto size-7 text-destructive" />
            )}
            <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">
              {notFound ? "工作空间不存在" : "工作空间读取失败"}
            </p>
            <p>{notFound ? "这个会话的工作目录已被清理，或还没产生任何文件" : error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={refreshAll}>
              <RefreshCw />
              重试
            </Button>
          </div>
        ) : rootNodes?.length === 0 ? (
          <div className="px-6 py-10 text-center text-muted-foreground">
            <FolderOpen className="mx-auto size-7" />
            <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">空目录</p>
            <p>这个会话还没有生成文件。</p>
            {onSuggestAction && (
              <Button variant="outline" size="sm" className="mt-3" onClick={onSuggestAction}>
                <Sparkles />
                让智能体生成点东西
              </Button>
            )}
          </div>
        ) : (
          <FileTree
            className="rounded-none border-0 bg-transparent font-sans [&>div]:px-2 [&>div]:py-1.5"
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

      {/* 文件预览错误不能替换整棵文件树。用户仍可选择其它文件。 */}
      {previewError && (
        <div className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-2.5 text-[13px] text-destructive">
          <span className="min-w-0 flex-1 truncate">预览失败：{previewError}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭预览错误"
            onClick={() => setPreviewError(null)}
          >
            <X />
          </Button>
        </div>
      )}

      {/* 文件预览 */}
      {preview && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-line-soft py-2 pr-2.5 pl-4">
            <b className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={preview.path}>
              {name}
            </b>
            {(isHtml || isMarkdown) && (
              <fieldset className="mr-1 inline-flex rounded-full bg-[#ECEAE3] p-[3px]">
                <legend className="sr-only">预览方式</legend>
                {(
                  [
                    [true, "预览"],
                    [false, "源码"],
                  ] as const
                ).map(([rendered, label]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={showRendered === rendered}
                    onClick={() => setShowRendered(rendered)}
                    className={cn(
                      "h-7 rounded-full px-3 text-[13px] text-muted-foreground",
                      showRendered === rendered &&
                        "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/6%)]",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            )}
            {/* 复制按钮放头部而不是浮在代码上 —— 侧栏太窄,浮动按钮会直接压住第一行 */}
            {preview.text !== null && (
              <Button
                variant="ghost"
                size="icon-sm"
                title="复制内容"
                aria-label="复制文件内容"
                onClick={() => {
                  void navigator.clipboard.writeText(preview.text ?? "").then(
                    () => toast.success("文件内容已复制"),
                    () => toast.error("复制失败，请手动选择内容"),
                  );
                }}
              >
                <Copy />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" asChild title="下载">
              <a aria-label="下载文件" href={fileUrl(false)}>
                <Download />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setPreview(null);
                setSelected(undefined);
              }}
              title="关闭预览"
              aria-label="关闭文件预览"
            >
              <X />
            </Button>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto",
              isHtml && showRendered ? "p-0" : "px-3.5 py-3",
            )}
          >
            {preview.mime.startsWith("image/") ? (
              <div className="flex justify-center rounded-[10px] bg-[#EDEBE5] p-4">
                <img src={fileUrl(true)} alt={preview.path} className="max-w-full rounded-md" />
              </div>
            ) : preview.mime.startsWith("video/") ? (
              <video
                controls
                preload="metadata"
                src={fileUrl(true)}
                className="mx-auto max-w-full rounded-md"
              >
                <track kind="captions" />
              </video>
            ) : preview.mime.startsWith("audio/") ? (
              <audio controls preload="metadata" src={fileUrl(true)} className="w-full">
                <track kind="captions" />
              </audio>
            ) : preview.mime === "application/pdf" ? (
              <iframe
                title={`预览 ${preview.path}`}
                src={fileUrl(true)}
                className="h-[70vh] w-full rounded-[10px] border border-border"
              />
            ) : isHtml && showRendered && preview.text !== null ? (
              /**
               * HTML 产物在隔离沙箱里渲染。
               *
               * 【为什么用 srcdoc 而不是指向文件的 URL】URL 会让这份 HTML 从本站源加载,
               * 那就是同源执行 —— 能读 cookie、能打同源接口。srcdoc 配合 sandbox
               * 让它落在一个不透明源里,跟本站没有任何关系。
               *
               * 【为什么 sandbox 里绝不能加 allow-same-origin】allow-scripts 与
               * allow-same-origin 同时给,等于没有沙箱:里面的脚本可以拿到父文档、
               * 甚至把 iframe 的 sandbox 属性摘掉。要么不给脚本,要么不给同源。
               */
              <iframe
                title={`预览 ${preview.path}`}
                srcDoc={preview.text}
                sandbox="allow-scripts"
                className="h-full min-h-[360px] w-full border-0 bg-white"
              />
            ) : isMarkdown && showRendered && preview.text !== null ? (
              // Markdown 用对话正文同一套渲染
              <div className="chat-md text-sm leading-[1.7]">
                <MessageResponse>{preview.text}</MessageResponse>
              </div>
            ) : preview.text === null ? (
              <div className="px-4 py-8 text-center text-muted-foreground">
                <FileText className="mx-auto size-7" />
                <p className="mt-2.5 mb-1 font-display text-[17px] text-foreground">
                  无法预览这个文件
                </p>
                <p>
                  {name} 是二进制文件（{preview.mime}，{formatSize(preview.size)}
                  ），下载后用本地程序打开。
                </p>
                <Button size="sm" className="mt-3" asChild>
                  <a href={fileUrl(false)}>
                    <Download />
                    下载
                  </a>
                </Button>
              </div>
            ) : (
              /**
               * 侧栏只有三四百像素宽,不换行的话每一行都被切掉大半,
               * 要横向拖着看 —— 预览的意义就没了。
               *
               * 行号是 ::before 伪元素(w-8 + mr-4 = 3rem),一旦换行,
               * 续行会顶到最左边跟行号列串在一起;用等量的负缩进把续行推回代码列。
               */
              <CodeBlock
                className={
                  "text-[13px] [&_pre]:whitespace-pre-wrap [&_pre]:break-words " +
                  "[&_code>span]:pl-12 [&_code>span]:-indent-12"
                }
                code={preview.text}
                language={guessLanguage(preview.path)}
                showLineNumbers
              />
            )}
            {preview.truncated && (
              <p className="m-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-warning-soft px-2.5 py-2 text-[13px] text-warning-text">
                <AlertTriangle className="size-3.5 shrink-0" />
                内容过长，只显示了开头一部分。
                <a className="underline underline-offset-[3px]" href={fileUrl(false)}>
                  下载完整文件
                </a>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
