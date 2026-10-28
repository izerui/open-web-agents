"use client";

import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { CheckCircle2, HelpCircle, Loader2, Upload, XCircle } from "lucide-react";
import { useRef, useState } from "react";

type FileResult =
  | {
      file: string;
      ok: true;
      format: string;
      pages?: number;
      docs: { title: string; chars: number }[];
    }
  | { file: string; ok: false; reason: string; uncertain?: true };

const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv";
const FORMAT_LABEL: Record<string, string> = {
  pdf: "PDF",
  docx: "Word",
  pptx: "PPT",
  xlsx: "Excel",
  text: "文本",
};

/**
 * 知识库上传文件:可多选或拖进来。每个文件提取文字后存成文档(过长自动切成几篇),逐个显示结果。
 * 只存提取出的文字,不存原文件。
 */
export function KnowledgeUpload({
  agentId,
  onUploaded,
}: {
  agentId: string;
  onUploaded: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FileResult[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(files: File[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await fetch(`/api/agents/${agentId}/knowledge/upload`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: FileResult[];
        error?: string;
      };
      if (data.results) setResults(data.results);
      else setError(data.error ?? `上传失败(HTTP ${res.status})`);
      // 结果未知的也刷新列表:用户要据此核对是否已入库
      if (data.results?.some((r) => r.ok || r.uncertain)) await onUploaded();
    } catch (err) {
      setError(`上传失败:${errorText(err)}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground",
          dragging && "border-primary bg-primary/5",
          busy && "pointer-events-none opacity-60",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload([...e.dataTransfer.files]);
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        <span>{busy ? "正在提取文字…" : "上传文件(可多选,或拖到这里)"}</span>
        <span className="opacity-70">
          PDF、Word(.docx)、PPT(.pptx)、Excel(.xlsx)、文本;单个 20MB 以内。只保存提取出的文字
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="上传知识库文件"
          disabled={busy}
          onChange={(e) => void upload([...(e.target.files ?? [])])}
        />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {results.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="upload-results">
          {results.map((r, i) => (
            <li key={`${r.file}-${i}`} className="flex items-start gap-1.5">
              {r.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : r.uncertain ? (
                <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              )}
              <span className="min-w-0 break-words">
                <span className="font-medium">{r.file}</span>
                {r.ok ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {FORMAT_LABEL[r.format] ?? r.format}
                    {r.pages ? ` ${r.pages} 页` : ""},
                    {r.docs.reduce((n, d) => n + d.chars, 0).toLocaleString()} 字
                    {r.docs.length > 1 ? `,较长,已切成 ${r.docs.length} 篇` : ""}
                  </span>
                ) : (
                  <span className={r.uncertain ? "text-warning" : "text-destructive"}>
                    {" "}
                    — {r.reason}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
