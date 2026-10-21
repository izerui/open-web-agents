"use client";

import { Badge } from "@/components/ui/badge";
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
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { followRun } from "@/features/chat/follow-run";
import { ApprovalBar, type PendingQuestion } from "@/features/workbench/approval-bar";
import { ChatThread, type SubmitAnswer } from "@/features/workbench/conversation";
import { createEventBatcher } from "@/features/workbench/event-batcher";
import type { Turn } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { DesignDraft, DesignResource } from "@/lib/modules/agent/domain/design";
import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileDiff,
  FlaskConical,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Square,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { McpCheck } from "./mcp-check";
import { DiffView } from "./release-panel";

interface View {
  sessionId: string;
  targetId?: string;
  targetName?: string;
  legacy: boolean;
  busy: boolean;
  draft?: DesignDraft;
  resources?: DesignResource[];
  resourceAgentIds?: string[];
  revision?: string;
  previewToken?: string;
  conflict?: boolean;
  aiIssue?: string;
  issues?: { field: string; message: string }[];
  changes?: SnapshotChange[];
}

type HistoryItem = { id: string; title?: string };
type ResourceSource = { id: string; name: string; canWrite?: boolean };

export function DesignWorkspace({ initialSessionId }: { initialSessionId?: string }) {
  const [id, setId] = useState(initialSessionId ?? "");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sources, setSources] = useState<ResourceSource[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<DesignDraft | null>(null);
  const [parameters, setParameters] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  /** AI 编辑提问时在等的回答(同工作台:提问卡片上作答,智能体在同一轮里继续) */
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  const submitAnswer = useCallback<SubmitAnswer>(
    async (approvalId, body) => {
      if (!id) return;
      await fetchJson(`/api/sessions/${id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          "decline" in body
            ? { approvalId, decision: "denied" }
            : { approvalId, decision: "approved", answers: body.answers },
        ),
      });
      setApprovalRefresh((n) => n + 1);
    },
    [id],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"preview" | "reset" | null>(null);
  const [mobileTab, setMobileTab] = useState<"chat" | "draft">("chat");
  const [sourceId, setSourceId] = useState("");
  const streamRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const dirty =
    !!draft &&
    !!view?.draft &&
    (JSON.stringify(draft) !== JSON.stringify(view.draft) ||
      parameters !== JSON.stringify(view.draft.parameters, null, 2));
  const blocked = busy || running || loading || view?.busy === true;

  const accept = useCallback((next: View) => {
    setView(next);
    setDraft(next.draft ?? null);
    setParameters(next.draft ? JSON.stringify(next.draft.parameters, null, 2) : "");
  }, []);

  const loadLists = useCallback(async () => {
    const [h, a] = await Promise.all([
      fetchJson<{ sessions: HistoryItem[] }>("/api/agents/design"),
      fetchJson<{ agents: ResourceSource[] }>("/api/agents"),
    ]);
    setHistory(h.sessions);
    setSources(a.agents.filter((agent) => agent.canWrite));
  }, []);

  useEffect(() => {
    void loadLists().catch((err) => setError(errorText(err)));
  }, [loadLists]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const refresh = useCallback(async () => {
    if (!id) return;
    const next = await fetchJson<View>(`/api/agents/design/${id}`);
    accept(next);
    return next;
  }, [id, accept]);

  const watch = useCallback(
    async (
      sessionId: string,
      runId: string,
      abort: AbortController,
      initial?: ReadableStream<Uint8Array> | null,
    ) => {
      const seq = sequence.current;
      const batch = createEventBatcher((events) => {
        if (seq !== sequence.current) return;
        setTurns((all) =>
          all.map((t) => (t.runId === runId ? { ...t, events: [...t.events, ...events] } : t)),
        );
      });
      try {
        await followRun({ sessionId, runId, push: batch.push, signal: abort.signal, initial });
      } finally {
        batch.flush();
        if (seq === sequence.current && !abort.signal.aborted) {
          setTurns((all) => all.map((t) => (t.runId === runId ? { ...t, running: false } : t)));
          setRunning(false);
          runIdRef.current = undefined;
          const next = await fetchJson<View>(`/api/agents/design/${sessionId}`);
          accept(next);
          void loadLists().catch(() => {});
        }
      }
    },
    [accept, loadLists],
  );

  useEffect(() => {
    streamRef.current?.abort();
    const seq = ++sequence.current;
    setRunning(false);
    setTurns([]);
    setView(null);
    setDraft(null);
    setError("");
    if (!id) return;
    const abort = new AbortController();
    streamRef.current = abort;
    setLoading(true);
    void Promise.all([
      fetchJson<View>(`/api/agents/design/${id}`),
      fetchJson<{ turns: Turn[]; activeRunId?: string }>(`/api/sessions/${id}/history`),
    ])
      .then(([next, conversation]) => {
        if (seq !== sequence.current) return;
        accept(next);
        setTurns(conversation.turns);
        if (conversation.activeRunId) {
          setRunning(true);
          runIdRef.current = conversation.activeRunId;
          void watch(id, conversation.activeRunId, abort).catch((err) => setError(errorText(err)));
        }
      })
      .catch((err) => {
        if (seq === sequence.current) setError(errorText(err));
      })
      .finally(() => {
        if (seq === sequence.current) setLoading(false);
      });
    return () => {
      abort.abort();
    };
  }, [id, accept, watch]);

  function selectSession(next: string) {
    setId(next);
    window.history.replaceState(null, "", `/agents/design?session=${encodeURIComponent(next)}`);
  }

  async function create() {
    setBusy(true);
    try {
      const created = await fetchJson<{ sessionId: string }>("/api/agents/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      selectSession(created.sessionId);
      await loadLists();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft || !view) throw new Error("设计草稿尚未就绪");
    const next = await fetchJson<View>(`/api/agents/design/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: view.revision,
        draft: { ...draft, parameters: JSON.parse(parameters) },
      }),
    });
    accept(next);
    return next;
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function send(text = prompt) {
    if (!text.trim() || blocked || !view || view.legacy) return;
    await act(async () => {
      const current = dirty ? await saveDraft() : view;
      const abort = new AbortController();
      streamRef.current = abort;
      const response = await fetch(`/api/agents/design/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text.trim(), revision: current.revision }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      const runId = response.headers.get("X-Run-Id");
      if (!runId || !response.body) throw new Error("运行未返回事件流");
      runIdRef.current = runId;
      setTurns((all) => [
        ...all,
        {
          runId,
          prompt: text.trim(),
          events: [],
          running: true,
          startedAt: new Date().toISOString(),
        },
      ]);
      setPrompt("");
      setRunning(true);
      void watch(id, runId, abort, response.body).catch((err) => setError(errorText(err)));
    });
  }

  async function stop() {
    if (!runIdRef.current) return;
    await act(async () => {
      await fetchJson(`/api/sessions/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: runIdRef.current }),
      });
      // 继续等终态事件,不把取消 HTTP 成功误当成已经安全结束文件写入。
    });
  }

  async function changeSources(ids: string[]) {
    await act(async () => {
      const current = dirty ? await saveDraft() : view;
      if (!current) return;
      const next = await fetchJson<View>(`/api/agents/design/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: current.revision, resourceAgentIds: ids }),
      });
      accept(next);
      setSourceId("");
    });
  }

  return (
    <main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2">
        <Link href="/agents" aria-label="返回智能体" className="rounded p-2 hover:bg-muted">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="text-base font-semibold">AI 编辑</h1>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {view?.targetName ?? "新智能体"}
        </span>
        <span className="text-xs text-muted-foreground">平台算力</span>
        {view?.targetId && (
          <Link
            className="text-sm underline"
            href={`/agents?id=${encodeURIComponent(view.targetId)}`}
          >
            配置与发布
          </Link>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || dirty}
          onClick={() => void create()}
        >
          <Plus className="size-4" />
          新建设计
        </Button>
      </header>
      {error && (
        <div
          aria-live="assertive"
          className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="ghost" size="icon" title="关闭错误提示" onClick={() => setError("")}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 overflow-y-auto border-r p-3 lg:block">
          <h2 className="mb-3 text-xs font-medium text-muted-foreground">设计记录</h2>
          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy || dirty}
              onClick={() => selectSession(item.id)}
              aria-current={id === item.id ? "page" : undefined}
              className={`mb-1 w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50 ${id === item.id ? "bg-muted" : ""}`}
            >
              {item.title ?? "设计会话"}
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b p-2 lg:hidden">
            <NativeSelect
              aria-label="设计记录"
              value={id}
              disabled={busy || dirty}
              onChange={(event) => selectSession(event.target.value)}
            >
              <option value="">选择设计记录</option>
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title ?? item.id}
                </option>
              ))}
            </NativeSelect>
            <Button
              variant={mobileTab === "chat" ? "secondary" : "ghost"}
              size="icon"
              title="设计对话"
              onClick={() => setMobileTab("chat")}
            >
              <MessageSquare className="size-4" />
            </Button>
            <Button
              variant={mobileTab === "draft" ? "secondary" : "ghost"}
              size="icon"
              title="设计草稿"
              onClick={() => setMobileTab("draft")}
            >
              <FileDiff className="size-4" />
            </Button>
          </div>
          {!id ? (
            <div className="flex flex-1 items-center justify-center">
              <Button onClick={() => void create()} disabled={busy}>
                <Plus className="size-4" />
                创建智能体
              </Button>
            </div>
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-5 animate-spin" aria-label="载入中" />
            </div>
          ) : (
            <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(350px,43%)]">
              <section
                aria-label="设计对话"
                className={`${mobileTab === "chat" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`}
              >
                <div className="min-h-0 flex-1">
                  {turns.length ? (
                    <ChatThread
                      turns={turns}
                      onAnswerAction={(text) => void send(text)}
                      pendingQuestions={pendingQuestions}
                      submitAnswerAction={submitAnswer}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
                      你想创建或调整怎样的智能体？
                    </div>
                  )}
                </div>
                <ApprovalBar
                  sessionId={id || null}
                  running={running}
                  onQuestionsChange={setPendingQuestions}
                  refreshKey={approvalRefresh}
                />
                <form
                  className="space-y-2 border-t p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <label className="sr-only" htmlFor="design-prompt">
                    编辑要求
                  </label>
                  <TrialRunFeedback
                    sessionId={id}
                    disabled={running || !view || view.legacy}
                    onSelect={(feedback) => setPrompt(feedback)}
                  />
                  <Textarea
                    id="design-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="例如：把输出改成包含摘要和风险等级的 JSON"
                    className="min-h-24 resize-none"
                    disabled={view?.legacy || !view}
                  />
                  <div className="flex items-center justify-end gap-2">
                    {dirty && (
                      <span className="mr-auto text-xs text-muted-foreground">
                        发送前会保存当前设计草稿
                      </span>
                    )}
                    {running ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void stop()}
                        disabled={busy}
                      >
                        <Square className="size-4" />
                        停止
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        disabled={blocked || !prompt.trim() || !view || view.legacy}
                      >
                        <Send className="size-4" />
                        发送
                      </Button>
                    )}
                  </div>
                </form>
              </section>
              <section
                aria-label="设计草稿"
                className={`${mobileTab === "draft" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col border-l lg:flex`}
              >
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <h2 className="flex-1 text-sm font-medium">设计草稿{dirty ? " · 未保存" : ""}</h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="刷新草稿"
                    disabled={blocked || dirty}
                    onClick={() => void act(refresh)}
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={blocked || !draft}
                    onClick={() =>
                      void act(async () => {
                        if (dirty) await saveDraft();
                        else await refresh();
                        setDialog("preview");
                      })
                    }
                  >
                    <FileDiff className="size-4" />
                    差异与保存
                  </Button>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                  {(view?.legacy || view?.conflict) && (
                    <div className="space-y-2 rounded border border-warning/40 p-3">
                      <p className="text-sm">
                        {view.legacy
                          ? "旧设计没有保存基线,历史记录仍可查看。"
                          : "目标智能体已被修改,当前设计不能直接覆盖。"}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked}
                        onClick={() => setDialog("reset")}
                      >
                        载入当前草稿
                      </Button>
                    </div>
                  )}
                  {view?.aiIssue && (
                    <p aria-live="assertive" className="text-sm text-destructive">
                      {view.aiIssue}
                    </p>
                  )}
                  {draft && (
                    <>
                      <fieldset disabled={blocked} className="space-y-4">
                        <div className="space-y-1">
                          <label htmlFor="design-name" className="text-sm">
                            名称
                          </label>
                          <Input
                            id="design-name"
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="design-description" className="text-sm">
                            说明
                          </label>
                          <Input
                            id="design-description"
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="design-system" className="text-sm">
                            系统提示词
                          </label>
                          <Textarea
                            id="design-system"
                            value={draft.systemPrompt}
                            className="min-h-48"
                            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="design-parameters" className="text-sm">
                            模型、工具与契约
                          </label>
                          <Textarea
                            id="design-parameters"
                            value={parameters}
                            className="min-h-48 font-mono text-xs"
                            onChange={(e) => setParameters(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <label htmlFor="design-source" className="text-sm">
                            Skills / MCP 来源
                          </label>
                          <div className="flex gap-2">
                            <NativeSelect
                              id="design-source"
                              value={sourceId}
                              onChange={(e) => setSourceId(e.target.value)}
                            >
                              <option value="">选择已有智能体</option>
                              {sources
                                .filter((s) => !view?.resourceAgentIds?.includes(s.id))
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                            </NativeSelect>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              title="添加资源来源"
                              disabled={!sourceId}
                              onClick={() =>
                                void changeSources([...(view?.resourceAgentIds ?? []), sourceId])
                              }
                            >
                              <Plus className="size-4" />
                            </Button>
                          </div>
                          {view?.resourceAgentIds?.map((source) => (
                            <div key={source} className="flex items-center gap-2 text-xs">
                              <span className="min-w-0 flex-1 truncate">
                                {sources.find((s) => s.id === source)?.name ?? source}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                title="移除资源来源"
                                onClick={() =>
                                  void changeSources(
                                    (view.resourceAgentIds ?? []).filter((s) => s !== source),
                                  )
                                }
                              >
                                <X className="size-3" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        {(["skill", "mcp"] as const).map((kind) => (
                          <fieldset key={kind} className="space-y-2">
                            <legend className="mb-2 text-sm font-medium">
                              {kind === "skill" ? "Skills" : "MCP"}
                            </legend>
                            {(view?.resources ?? [])
                              .filter((r) => r.kind === kind)
                              .map((r) => {
                                const key = kind === "skill" ? "skillRefs" : "mcpRefs";
                                const inlineNames = new Set(
                                  kind === "skill"
                                    ? (draft.skillPackages ?? []).map((s) => s.name)
                                    : (draft.mcpServers ?? []).map((m) => m.name),
                                );
                                const conflict = inlineNames.has(r.name);
                                const savedRef = view?.draft?.mcpRefs.includes(r.ref) ?? false;
                                return (
                                  <div key={r.ref} className="space-y-1">
                                    <label
                                      className={`flex items-start gap-2 text-sm ${conflict ? "opacity-50" : ""}`}
                                      title={
                                        conflict
                                          ? `与 inline 定义「${r.name}」冲突，请先移除 inline 或不勾选`
                                          : undefined
                                      }
                                    >
                                      <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={draft[key].includes(r.ref)}
                                        disabled={conflict && !draft[key].includes(r.ref)}
                                        onChange={(e) =>
                                          setDraft({
                                            ...draft,
                                            [key]: e.target.checked
                                              ? [...draft[key], r.ref]
                                              : draft[key].filter((ref) => ref !== r.ref),
                                          })
                                        }
                                      />
                                      <span className="min-w-0 break-words">
                                        {r.name}
                                        <span className="ml-2 text-xs text-muted-foreground">
                                          {r.agentName}
                                        </span>
                                      </span>
                                    </label>
                                    {kind === "mcp" && draft.mcpRefs.includes(r.ref) && (
                                      <div className="pl-6">
                                        <McpCheck
                                          name={r.name}
                                          resetKey={`${r.ref}:${view?.revision ?? ""}`}
                                          disabledReason={
                                            dirty || !savedRef ? "先保存草稿再测试连接" : undefined
                                          }
                                          requestAction={() => ({
                                            url: `/api/agents/design/${id}/mcp-check`,
                                            body: { name: r.name },
                                          })}
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            {!view?.resources?.some((r) => r.kind === kind) && (
                              <p className="text-xs text-muted-foreground">暂无可用资源</p>
                            )}
                          </fieldset>
                        ))}
                      </fieldset>
                      {(draft.skillPackages?.length ?? 0) > 0 && (
                        <fieldset className="space-y-2">
                          <legend className="mb-2 text-sm font-medium">技能包（inline）</legend>
                          {draft.skillPackages?.map((s) => (
                            <SkillPreview key={s.name} skill={s} />
                          ))}
                        </fieldset>
                      )}
                      {(draft.mcpServers?.length ?? 0) > 0 && (
                        <fieldset className="space-y-2">
                          <legend className="mb-2 text-sm font-medium">MCP 服务（inline）</legend>
                          {draft.mcpServers?.map((m) => (
                            <div key={m.name} className="rounded border p-2 text-xs">
                              <p className="font-medium">
                                {m.name}{" "}
                                <span className="font-normal text-muted-foreground">{m.type}</span>
                              </p>
                              {m.url && (
                                <p className="mt-1 truncate text-muted-foreground">{m.url}</p>
                              )}
                              {m.env && (
                                <p className="mt-1 text-muted-foreground">
                                  env: {Object.keys(m.env).join(", ")}
                                </p>
                              )}
                              <div className="mt-2">
                                <McpCheck
                                  name={m.name}
                                  resetKey={`${m.name}:${view?.revision ?? ""}`}
                                  disabledReason={
                                    dirty ||
                                    !view?.draft?.mcpServers?.some((x) => x.name === m.name)
                                      ? "先保存草稿再测试连接"
                                      : undefined
                                  }
                                  requestAction={() => ({
                                    url: `/api/agents/design/${id}/mcp-check`,
                                    body: { name: m.name },
                                  })}
                                />
                              </div>
                            </div>
                          ))}
                        </fieldset>
                      )}
                      {(view?.issues?.length ?? 0) > 0 && (
                        <ul className="space-y-1 text-xs text-destructive">
                          {view?.issues?.map((issue, i) => (
                            <li key={`${issue.field}-${i}`}>
                              {issue.field}: {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                      <Button
                        variant="outline"
                        disabled={blocked || !dirty}
                        onClick={() =>
                          void act(async () => {
                            await saveDraft();
                            toast.success("设计草稿已保存");
                          })
                        }
                      >
                        <Save className="size-4" />
                        保存设计草稿
                      </Button>
                    </>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === "reset" ? "载入目标智能体当前草稿" : "确认保存到智能体草稿"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "reset"
                ? "当前设计草稿会被替换。对话历史仍保留。"
                : "保存不会创建或切换发布版本。尚未发布过的智能体仍沿用现有草稿调用规则。"}
            </DialogDescription>
          </DialogHeader>
          {dialog === "preview" && (
            <>
              <DiffView title="配置变更" changes={view?.changes ?? []} />
              {view?.conflict && (
                <p className="text-sm text-destructive">目标草稿已变化,不能覆盖。</p>
              )}
              {view?.issues?.map((issue, i) => (
                <p key={`${issue.field}-${i}`} className="text-sm text-destructive">
                  {issue.field}: {issue.message}
                </p>
              ))}
            </>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              disabled={
                busy ||
                (dialog === "preview" &&
                  (view?.conflict || !!view?.issues?.length || !view?.previewToken))
              }
              onClick={() =>
                void act(async () => {
                  if (dialog === "reset") {
                    accept(
                      await fetchJson<View>(`/api/agents/design/${id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ reset: true, revision: view?.revision }),
                      }),
                    );
                  } else {
                    const result = await fetchJson<{
                      agent: { name: string };
                    }>("/api/agents/design/apply", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ sessionId: id, previewToken: view?.previewToken }),
                    });
                    await refresh();
                    await loadLists();
                    toast.success(`已保存「${result.agent.name}」草稿`);
                  }
                  setDialog(null);
                })
              }
            >
              <Check className="size-4" />
              {dialog === "reset" ? "确认载入" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

interface TrialRun {
  runId: string;
  status: string;
  promptPreview: string;
  text?: string;
  structured?: string;
  error?: { kind?: string; message?: string };
  at: number;
}

function TrialRunFeedback({
  sessionId,
  disabled,
  onSelect,
}: {
  sessionId: string;
  disabled: boolean;
  onSelect: (feedback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<TrialRun[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/design/${encodeURIComponent(sessionId)}/runs`);
      if (res.ok) {
        const data = (await res.json()) as { runs: TrialRun[] };
        setRuns(data.runs);
      }
    } catch {}
    setLoading(false);
  }

  function select(run: TrialRun) {
    const parts = ["基于以下试运行结果改进智能体配置：\n"];
    parts.push(`【输入】\n${run.promptPreview}\n`);
    if (run.text) parts.push(`【输出】\n${run.text}\n`);
    if (run.structured) parts.push(`【结构化结果】\n${run.structured}\n`);
    if (run.error) parts.push(`【错误】\n${run.error.message ?? run.error.kind ?? "未知错误"}\n`);
    parts.push("请分析问题并修改草稿。");
    onSelect(parts.join("\n"));
    setOpen(false);
  }

  return (
    <div className="mb-1">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        disabled={disabled}
        onClick={() => {
          if (!open) void load();
          setOpen(!open);
        }}
      >
        <FlaskConical className="size-3" />
        {open ? "收起试运行反馈" : "从试运行结果反馈"}
      </button>
      {open && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border p-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">载入中…</p>
          ) : !runs?.length ? (
            <p className="text-xs text-muted-foreground">暂无试运行记录</p>
          ) : (
            runs.map((run) => (
              <div
                key={run.runId}
                className="flex items-center gap-2 rounded p-1.5 text-xs hover:bg-muted/50"
              >
                <Badge
                  variant={
                    run.status === "success"
                      ? "secondary"
                      : run.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                  className="shrink-0 text-[10px]"
                >
                  {run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "取消"}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{run.promptPreview}</span>
                <span className="shrink-0 text-muted-foreground">
                  {new Date(run.at).toLocaleString()}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-[10px]"
                  disabled={disabled}
                  onClick={() => select(run)}
                >
                  反馈给 AI
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SkillPreview({
  skill,
}: { skill: { name: string; description: string; files: Record<string, string> } }) {
  const [expanded, setExpanded] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const fileKeys = Object.keys(skill.files);

  return (
    <div className="rounded border p-2 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 font-medium">{skill.name}</span>
        <span className="text-muted-foreground">{fileKeys.length} 个文件</span>
      </button>
      {skill.description && (
        <p className="mt-0.5 pl-4.5 text-muted-foreground">{skill.description}</p>
      )}
      {expanded && (
        <div className="mt-1.5 space-y-1 pl-4.5">
          {fileKeys.map((path) => (
            <div key={path}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                onClick={() => setOpenFile(openFile === path ? null : path)}
              >
                <FileCode className="size-3 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate font-mono">{path}</span>
                <span className="text-muted-foreground">{skill.files[path]?.length ?? 0} 字符</span>
              </button>
              {openFile === path && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                  {skill.files[path]}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
