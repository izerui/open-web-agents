"use client";

import { useCallback, useEffect, useState } from "react";

interface Doc {
  id: string;
  title: string;
  createdAt: number;
}

const field =
  "w-full rounded border border-black/15 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/40 dark:border-white/20";

/**
 * 助手知识库面板。
 * 与会话工作空间的区别:工作空间每会话独立、开局为空;知识库是助手级、跨会话长存,
 * 运行时按用户问题检索相关片段注入提示词。
 */
export function KnowledgePanel({
  assistantId,
  canWrite = true,
}: {
  assistantId: string;
  canWrite?: boolean;
}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/assistants/${assistantId}/knowledge`);
    if (res.status === 403 || res.status === 404) {
      setDenied(true);
      return;
    }
    const d = (await res.json()) as { docs?: Doc[] };
    setDenied(false);
    setDocs(d.docs ?? []);
  }, [assistantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function add() {
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/assistants/${assistantId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMsg(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setTitle("");
      setContent("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove(docId: string) {
    await fetch(`/api/assistants/${assistantId}/knowledge?docId=${encodeURIComponent(docId)}`, {
      method: "DELETE",
    });
    await reload();
  }

  if (denied) return null;

  return (
    <div className="space-y-2 rounded border border-black/10 p-3 dark:border-white/15">
      <div>
        <span className="font-medium text-xs">知识库</span>
        <p className="text-xs opacity-55">
          助手级、跨会话长存。运行时按用户问题检索相关片段注入提示词;没命中就不注入。
        </p>
      </div>

      {!canWrite && (
        <p className="text-xs opacity-45">
          这个助手是别人分享给你的 —— 可以看资料清单,但不能增删。
        </p>
      )}

      {canWrite && (
        <>
          <input
            className={field}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文档标题,如「报销制度」"
          />
          <textarea
            className={`${field} h-28 resize-y font-mono`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="粘贴文档正文…"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded bg-black px-3 py-1 text-white text-xs disabled:opacity-40 dark:bg-white dark:text-black"
              onClick={add}
              disabled={!title.trim() || !content.trim() || busy}
            >
              {busy ? "添加中…" : "添加文档"}
            </button>
            {msg && <span className="text-red-600 text-xs">{msg}</span>}
          </div>
        </>
      )}

      {docs.length === 0 && <p className="text-xs opacity-40">还没有知识文档</p>}
      {docs.map((d) => (
        <div key={d.id} className="flex items-center gap-2 text-xs">
          <span className="flex-1 truncate">📄 {d.title}</span>
          {canWrite && (
            <button
              type="button"
              className="text-red-600 underline opacity-70 hover:opacity-100"
              onClick={() => remove(d.id)}
            >
              删除
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
