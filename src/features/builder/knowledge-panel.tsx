"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Pencil,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KnowledgeSearch } from "./knowledge-search";
import { KnowledgeUpload } from "./knowledge-upload";

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
 * 排版按原型(构建页档案「知识」节):说明、篇数与字数进度、文档列表、拖放区(手动添加收进弹窗)、检索测试。
 */
export function KnowledgePanel({
  agentId,
  canWrite = true,
  onChanged,
}: {
  agentId: string;
  canWrite?: boolean;
  /** 文档增删改之后(档案摘要据此刷新) */
  onChanged?: () => void;
}) {
  const confirm = useConfirm();
  const [manualOpen, setManualOpen] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;
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
      if (seq === reloadSeqRef.current) setMsg(`知识库加载失败：${errorText(error)}`);
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
      setManualOpen(false);
      await reload();
      changed.current?.();
    } catch (error) {
      setMsg(`添加失败：${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function remove(doc: Doc) {
    confirm.ask({
      title: `删除知识文档「${doc.title}」？`,
      description: "删除后无法恢复，运行时也不会再检索到它。",
      confirmLabel: "删除",
      destructive: true,
      onConfirm: () => removeNow(doc.id),
    });
  }

  async function removeNow(docId: string) {
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
      changed.current?.();
    } catch (error) {
      setMsg(`删除失败：${errorText(error)}`);
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
      setMsg(`加载文档失败：${errorText(error)}`);
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
    const reloadBefore = reloadSeqRef.current;
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, string> = { docId: targetDocId };
      if (editTitle.trim() !== detail.title) body.title = editTitle.trim();
      if (editContent !== detail.content) body.content = editContent;
      if (!editTitle.trim()) {
        setMsg("标题不能为空");
        return;
      }
      if (body.content !== undefined && !body.content.trim()) {
        setMsg("正文不能为空");
        return;
      }
      if (body.title === undefined && body.content === undefined) {
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
      if (reloadBefore === reloadSeqRef.current) await reload();
      changed.current?.();
    } catch (error) {
      if (seq === detailSeqRef.current) setMsg(`保存失败：${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  if (denied) return null;

  const maxDocs = usage?.limits.maxDocs ?? 0;
  const outCount = docs.filter((d) => !d.searchable).length;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="m-0 text-muted-foreground">
        知识按智能体保存，跨会话有效；运行时按问题检索相关片段注入提示词，没命中就不注入。
      </p>
      {usage && (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 text-[13px]">
          <span className="inline-flex items-center gap-2">
            文档{" "}
            <b className="tabular-nums">
              {usage.usage.docs}/{maxDocs}
            </b>{" "}
            篇
            <span
              className="inline-block h-1.5 w-20 overflow-hidden rounded-[3px] bg-[#ECEAE3]"
              aria-hidden
            >
              <i
                className={cn(
                  "block h-full bg-foreground",
                  usage.usage.docs > maxDocs && "bg-warning",
                )}
                style={{
                  width: `${Math.min(100, (usage.usage.docs / Math.max(1, maxDocs)) * 100)}%`,
                }}
              />
            </span>
          </span>
          <span>
            字数{" "}
            <b className="tabular-nums">
              {usage.usage.chars.toLocaleString()}/{usage.limits.maxTotalChars.toLocaleString()}
            </b>
          </span>
          <span className="text-muted-foreground">
            单篇 {usage.limits.maxDocChars.toLocaleString()} 字以内，更长的自动切篇
          </span>
        </div>
      )}
      {outCount > 0 && (
        <div className="flex items-start gap-2 rounded-[14px] bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            超出篇数上限 {maxDocs} 篇：最早的 {outCount} 篇<b>不参与检索</b>
            。删除不用的文档后，它们会按上传先后依次恢复。
          </span>
        </div>
      )}

      {!canWrite && (
        <p className="m-0 text-[13px] text-muted-foreground">
          这个智能体是别人分享给你的，可以看资料清单，但不能增删。
        </p>
      )}

      {msg && <p className="m-0 text-[13px] text-destructive">{msg}</p>}

      <div className="overflow-hidden rounded-xl border border-border">
        {!loaded && <div className="px-3 py-2.5 text-muted-foreground">载入中…</div>}
        {loaded && docs.length === 0 && (
          <div className="px-3 py-2.5 text-muted-foreground">还没有知识文档</div>
        )}
        {docs.map((d) => (
          <div key={d.id} className="border-b border-line-soft last:border-0">
            <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
              <button
                type="button"
                aria-expanded={expandedId === d.id}
                className="flex min-w-0 cursor-pointer items-center gap-2 text-left hover:opacity-80"
                onClick={() => void toggleExpand(d.id)}
              >
                {expandedId === d.id ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span
                  className={cn("truncate font-medium", !d.searchable && "text-muted-foreground")}
                >
                  {d.title}
                </span>
              </button>
              <span className="shrink-0 text-[13px] text-muted-foreground">
                {d.chars.toLocaleString()} 字
              </span>
              {!d.searchable && (
                <span className="shrink-0 rounded-full bg-warning-soft px-2 py-px text-xs text-warning-text">
                  不参与检索
                </span>
              )}
              <span className="flex-1" />
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="删除"
                  aria-label={`删除知识文档 ${d.title}`}
                  className="text-muted-foreground hover:text-destructive max-md:size-11"
                  disabled={deletingId === d.id}
                  onClick={() => remove(d)}
                >
                  <Trash2 />
                </Button>
              )}
            </div>

            {expandedId === d.id && (
              <div className="border-t border-line-soft px-3 py-2.5">
                {loadingDetail && <p className="m-0 text-muted-foreground">加载正文中…</p>}
                {detail?.id === d.id && !editMode && (
                  <div className="space-y-2">
                    <pre className="m-0 max-h-60 overflow-auto rounded-[10px] bg-[#F6F5F1] px-3 py-2 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">
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
                      maxLength={255}
                      aria-label="文档标题"
                      placeholder="文档标题"
                    />
                    <Textarea
                      className="h-40 resize-y text-[13px]"
                      aria-label="文档正文"
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

      {canWrite && (
        <KnowledgeUpload
          agentId={agentId}
          onUploaded={async () => {
            await reload();
            changed.current?.();
          }}
          onManualAdd={() => {
            setMsg(null);
            setManualOpen(true);
          }}
        />
      )}

      {loaded && docs.length > 0 && <KnowledgeSearch agentId={agentId} />}

      <Dialog open={manualOpen} onOpenChange={(o) => !busy && setManualOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动添加知识</DialogTitle>
            <DialogDescription>
              粘贴一段文字存成一篇文档，运行时和上传的文档一起检索。
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
              标题
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={255}
                placeholder="例如 报销制度"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
              正文
              <Textarea
                className="h-40 resize-y text-sm text-foreground"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="粘贴文档正文…"
              />
            </label>
            {msg && <p className="m-0 text-[13px] text-destructive">{msg}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setManualOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!title.trim() || !content.trim() || busy}>
                {busy ? "添加中…" : "添加"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {confirm.dialog}
    </div>
  );
}
