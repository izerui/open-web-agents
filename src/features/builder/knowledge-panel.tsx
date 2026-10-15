"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, FileText, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface Doc {
  id: string;
  title: string;
  createdAt: number;
  chars: number;
  searchable: boolean;
}

interface Usage {
  usage: { docs: number; chars: number };
  limits: { maxDocs: number; maxDocChars: number; maxTotalChars: number };
}

interface DocDetail {
  id: string;
  title: string;
  content: string;
}

/**
 * 智能体知识库面板。
 * 与会话工作空间的区别:工作空间每会话独立、开局为空;知识库是智能体级、跨会话长存,
 * 运行时按用户问题检索相关片段注入提示词。
 */
export function KnowledgePanel({
  agentId,
  canWrite = true,
}: {
  agentId: string;
  canWrite?: boolean;
}) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reloadSeqRef = useRef(0);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const detailSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const res = await fetch(`/api/agents/${agentId}/knowledge`);
      if (res.status === 403 || res.status === 404) {
        if (seq === reloadSeqRef.current) setDenied(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { docs?: Doc[] } & Partial<Usage>;
      if (seq !== reloadSeqRef.current) return;
      setDenied(false);
      setDocs(data.docs ?? []);
      setUsage(data.usage && data.limits ? { usage: data.usage, limits: data.limits } : null);
      setMsg(null);
    } catch (error) {
      if (seq === reloadSeqRef.current) setMsg(`知识库加载失败:${errorText(error)}`);
    } finally {
      if (seq === reloadSeqRef.current) setLoaded(true);
    }
  }, [agentId]);

  useEffect(() => {
    reloadSeqRef.current += 1;
    detailSeqRef.current += 1;
    setLoaded(false);
    setDocs([]);
    setTitle("");
    setContent("");
    setMsg(null);
    setDenied(false);
    setExpandedId(null);
    setDetail(null);
    setEditMode(false);
    void reload();
  }, [reload]);

  async function add() {
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fetchJson(`/api/agents/${agentId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      setTitle("");
      setContent("");
      await reload();
    } catch (error) {
      setMsg(`添加失败:${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(docId: string) {
    if (!window.confirm("确定删除这份知识文档？删除后无法恢复。")) return;
    setDeletingId(docId);
    setMsg(null);
    try {
      await fetchJson(`/api/agents/${agentId}/knowledge?docId=${encodeURIComponent(docId)}`, {
        method: "DELETE",
      });
      if (expandedId === docId) {
        setExpandedId(null);
        setDetail(null);
        setEditMode(false);
      }
      await reload();
    } catch (error) {
      setMsg(`删除失败:${errorText(error)}`);
    } finally {
      setDeletingId(null);
    }
  }

  async function toggleExpand(docId: string) {
    if (expandedId === docId) {
      setExpandedId(null);
      setDetail(null);
      setEditMode(false);
      return;
    }
    setExpandedId(docId);
    setEditMode(false);
    setDetail(null);
    setLoadingDetail(true);
    const seq = ++detailSeqRef.current;
    try {
      const res = await fetch(`/api/agents/${agentId}/knowledge/${encodeURIComponent(docId)}`);
      if (seq !== detailSeqRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DocDetail;
      if (seq !== detailSeqRef.current) return;
      setDetail(data);
    } catch (error) {
      if (seq !== detailSeqRef.current) return;
      setMsg(`加载文档失败:${errorText(error)}`);
      setExpandedId(null);
    } finally {
      if (seq === detailSeqRef.current) setLoadingDetail(false);
    }
  }

  function enterEdit() {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditContent(detail.content);
    setEditMode(true);
  }

  async function saveEdit() {
    if (!detail || saving) return;
    const targetDocId = detail.id;
    const seq = detailSeqRef.current;
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, string> = { docId: targetDocId };
      if (editTitle.trim() !== detail.title) body.title = editTitle.trim();
      if (editContent !== detail.content) body.content = editContent;
      if (!body.title && !body.content) {
        setEditMode(false);
        return;
      }
      await fetchJson(`/api/agents/${agentId}/knowledge`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (seq === detailSeqRef.current && expandedId === targetDocId) {
        setDetail({
          ...detail,
          title: body.title ?? detail.title,
          content: body.content ?? detail.content,
        });
        setEditMode(false);
      }
      await reload();
    } catch (error) {
      if (seq === detailSeqRef.current) setMsg(`保存失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (denied) return null;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div>
        <span className="font-medium text-xs">知识库</span>
        <p className="text-xs opacity-55">
          智能体级、跨会话长存。运行时按用户问题检索相关片段注入提示词;没命中就不注入。
        </p>
        {usage && (
          <p className="text-xs text-muted-foreground">
            已用 {usage.usage.docs} / {usage.limits.maxDocs} 篇,
            {usage.usage.chars.toLocaleString()} / {usage.limits.maxTotalChars.toLocaleString()} 字
            (单篇上限 {usage.limits.maxDocChars.toLocaleString()} 字)
          </p>
        )}
      </div>
      {docs.some((d) => !d.searchable) && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          有 {docs.filter((d) => !d.searchable).length} 篇文档超出 {usage?.limits.maxDocs}{" "}
          篇上限,不参与检索(上限设立之前写入的)。删除不用的文档后,它们会按上传先后依次恢复。
        </p>
      )}

      {!canWrite && (
        <p className="text-xs opacity-45">
          这个智能体是别人分享给你的 —— 可以看资料清单,但不能增删。
        </p>
      )}

      {canWrite && (
        <>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文档标题,如「报销制度」"
          />
          <Textarea
            className="h-28 resize-y font-mono text-xs"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="粘贴文档正文…"
          />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={add}
              disabled={!title.trim() || !content.trim() || busy}
            >
              <Plus className="size-3.5" />
              {busy ? "添加中…" : "添加文档"}
            </Button>
          </div>
        </>
      )}

      {msg && <p className="text-xs text-destructive">{msg}</p>}

      {!loaded && <p className="text-xs text-muted-foreground">载入中…</p>}
      {loaded && !msg && docs.length === 0 && (
        <p className="text-xs text-muted-foreground">还没有知识文档</p>
      )}
      {docs.map((d) => (
        <div key={d.id} className="rounded-md border border-border">
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
            <button
              type="button"
              className="flex flex-1 cursor-pointer items-center gap-2 text-left hover:opacity-80"
              onClick={() => void toggleExpand(d.id)}
            >
              {expandedId === d.id ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn("flex-1 truncate", !d.searchable && "text-muted-foreground")}>
                {d.title}
              </span>
            </button>
            {!d.searchable && <span className="shrink-0 text-[11px] text-warning">不参与检索</span>}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {d.chars.toLocaleString()} 字
            </span>
            {canWrite && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="删除"
                aria-label={`删除知识文档 ${d.title}`}
                className="text-muted-foreground hover:text-destructive"
                disabled={deletingId === d.id}
                onClick={() => void remove(d.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>

          {expandedId === d.id && (
            <div className="border-t border-border px-3 py-2">
              {loadingDetail && <p className="text-xs text-muted-foreground">加载正文中…</p>}
              {detail?.id === d.id && !editMode && (
                <div className="space-y-2">
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed">
                    {detail.content}
                  </pre>
                  {canWrite && (
                    <Button type="button" variant="outline" size="sm" onClick={enterEdit}>
                      <Pencil className="size-3.5" />
                      编辑
                    </Button>
                  )}
                </div>
              )}
              {detail?.id === d.id && editMode && (
                <div className="space-y-2">
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="文档标题"
                  />
                  <Textarea
                    className="h-40 resize-y font-mono text-xs"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void saveEdit()}
                      disabled={saving || !editTitle.trim()}
                    >
                      {saving ? "保存中…" : "保存"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditMode(false)}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
