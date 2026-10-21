"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { Search } from "lucide-react";
import { useState } from "react";

interface Hit {
  docId: string;
  docTitle: string;
  index: number;
  score: number;
  text: string;
}

/**
 * 检索测试:输入一个问题,看运行时会带入哪些资料片段 —— 与运行时同一份检索逻辑。
 * 不调用模型,不消耗积分
 */
export function KnowledgeSearch({ agentId }: { agentId: string }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hits: Hit[]; context: string } | null>(null);
  const [error, setError] = useState("");
  const [showContext, setShowContext] = useState(false);

  async function search() {
    if (!query.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await fetchJson<{ hits: Hit[]; context: string }>(
          `/api/agents/${agentId}/knowledge/search`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: query.trim() }),
          },
        ),
      );
      setShowContext(false);
    } catch (err) {
      setError(`检索失败:${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="space-y-2 rounded-md border border-dashed border-border p-2"
      data-testid="knowledge-search"
    >
      <p className="text-xs font-medium">检索测试</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={2000}
          placeholder="输入一个问题,看运行时会带入哪些资料"
          aria-label="检索测试问题"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!query.trim() || busy}>
          <Search className="size-3.5" />
          {busy ? "检索中…" : "检索"}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result && result.hits.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="knowledge-search-empty">
          没有命中:这个问题运行时不会带入任何资料
        </p>
      )}
      {result && result.hits.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            命中 {result.hits.length} 段,运行时会按下面的顺序带入:
          </p>
          <ol className="space-y-2">
            {result.hits.map((h) => (
              <li
                key={`${h.docId}-${h.index}`}
                className="rounded-md border p-2 text-xs"
                data-testid="knowledge-hit"
              >
                <p className="mb-1 flex items-center gap-2">
                  <span className="font-medium">{h.docTitle}</span>
                  <span className="text-muted-foreground">片段 {h.index + 1}</span>
                  <span className="ml-auto text-muted-foreground tabular-nums">得分 {h.score}</span>
                </p>
                <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
                  {h.text}
                </p>
              </li>
            ))}
          </ol>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowContext((v) => !v)}>
            {showContext ? "收起实际注入的文本" : "查看实际注入给模型的文本"}
          </Button>
          {showContext && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
              {result.context}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
