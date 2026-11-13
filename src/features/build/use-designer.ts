"use client";

// 智能体设计器(原 /agents/design,由内置智能体 agent-architect 驱动)的状态与接口调用。
// 承接原 design-workspace 的全部能力:设计记录切换与新建、对话与提问卡片、审批、停止、
// 从试运行结果反馈、legacy / conflict / aiIssue、整体「差异与保存」、Skills/MCP 资源引用;
// 新增按节应用(A4)、让设计器修复评测失败(A7 只是往这里发一句话),以及档案自动保存后的基线跟随。

import { followRun } from "@/features/chat/follow-run";
import type { PendingQuestion } from "@/features/workbench/approval-bar";
import { joinPromptAttachments } from "@/features/workbench/chat-view.logic";
import type { SubmitAnswer } from "@/features/workbench/conversation";
import { createEventBatcher } from "@/features/workbench/event-batcher";
import type { Turn } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { DesignDraft, DesignResource } from "@/lib/modules/agent/domain/design";
import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { uploadDesignFiles } from "./design-files";
import {
  type DesignSection,
  changedSections,
  groupChanges,
  mergeDesignSections,
  sectionOfChangePath,
} from "./design-sections";
import {
  type Outcome,
  type Outcomes,
  addAttachments,
  pendingAnchor,
  shouldAutoSend,
} from "./designer-model";

export interface DesignView {
  sessionId: string;
  targetId?: string;
  targetName?: string;
  legacy: boolean;
  busy: boolean;
  draft?: DesignDraft;
  /** 目标智能体当前内容对应的设计草稿(按节拆分与还原用) */
  base?: DesignDraft;
  resources?: DesignResource[];
  resourceAgentIds?: string[];
  revision?: string;
  previewToken?: string;
  conflict?: boolean;
  aiIssue?: string;
  issues?: { field: string; message: string }[];
  changes?: SnapshotChange[];
  /** 每一轮改动的处理结果(已应用 / 没有应用),服务端按设计会话保存 */
  outcomes?: Outcomes;
}

export type DesignRecord = {
  id: string;
  title?: string;
  createdAt?: number;
  designTargetAgentId?: string;
};

export interface TrialRun {
  runId: string;
  status: string;
  promptPreview: string;
  text?: string;
  structured?: string;
  error?: { kind?: string; message?: string };
  at: number;
}

export interface Applied {
  agentId: string;
  created: boolean;
  sections: DesignSection[];
}

const EMPTY_OUTCOMES: Outcomes = {};

const json = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function useDesigner(opts: {
  /** 目标智能体;null = 新建(还没有智能体) */
  agentId: string | null;
  initialSession?: string;
  /**
   * 新建弹层带来的描述:预填进输入框;会话还没有任何轮次时自动发给设计器(取舍 1:
   * 用户在弹层里已经明确点了「用设计器创建」),发完调 onAutoSent(页面从地址里去掉 desc,刷新不会重发)
   */
  initialPrompt?: string;
  /** 和描述一起带来的附件:已经传进这个设计会话的工作区(探索首页「用设计器创建」),自动发送时列进提示词 */
  initialFiles?: string[];
  onAutoSent?: () => void;
  /** 只读视图不加载设计器 */
  enabled: boolean;
  /** 应用之前先把档案里没落盘的修改存掉;存不了返回 false */
  beforeApply: () => Promise<boolean>;
  onApplied: (r: Applied) => void | Promise<void>;
  /** 会话切换:页面把它写进地址 ?designer= */
  onSessionChange: (id: string | null) => void;
}) {
  const { agentId, enabled } = opts;
  const cb = useRef(opts);
  cb.current = opts;
  const [sessionId, setSessionId] = useState(opts.initialSession ?? "");
  const [history, setHistory] = useState<DesignRecord[] | null>(null);
  const [view, setView] = useState<DesignView | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState(opts.initialPrompt ?? "");
  /** 输入框里待发送的附件:发送时先传进设计会话的工作区,再把文件名列在提示词末尾(与对话页一致) */
  const [files, setFiles] = useState<File[]>([]);
  /**
   * 已经传进工作区、但这一轮没发出去的附件(运行被拒,比如积分不足;或探索首页带来的附件自动发送失败)。
   * 下次发送时照样列进提示词,不用再传一次(再传会撞同名文件)
   */
  const [carried, setCarried] = useState<string[]>([]);
  const filesRef = useRef<File[]>([]);
  filesRef.current = files;
  const addFiles = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    const r = addAttachments(filesRef.current, incoming);
    filesRef.current = r.files;
    setFiles(r.files);
    if (r.rejected.length) setError(r.rejected.join("；"));
  }, []);
  const removeFile = useCallback((name: string) => {
    setFiles((cur) => cur.filter((f) => f.name !== name));
  }, []);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  /** 正在处理的节(按钮转圈) */
  const [working, setWorking] = useState<DesignSection | "all" | null>(null);
  const streamRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const viewRef = useRef<DesignView | null>(null);
  viewRef.current = view;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  /** 档案自动保存改了目标:设计基线要跟上(见 rebaseIfNeeded) */
  const selfSaved = useRef(false);
  const autoPicked = useRef(Boolean(opts.initialSession));

  const blocked = busy || running || loading || view?.busy === true;
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  /**
   * 每一轮里改动的处理结果(已应用 / 没有应用),存在设计会话的服务端状态里,留在对话历史里。
   * 写完用返回的全部记录更新当前预览;写失败只影响这条留痕,不打断应用 / 先不改。
   */
  const recordOutcomes = useCallback(async (list: Outcome[]) => {
    const sid = sessionRef.current;
    const all = turnsRef.current;
    const i = pendingAnchor(all);
    if (!sid || i < 0 || list.length === 0) return;
    const turnKey = all[i]?.runId ?? `turn-${i}`;
    try {
      const res = await fetchJson<{ outcomes: Outcomes }>(
        `/api/agents/design/${encodeURIComponent(sid)}/outcomes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnKey, outcomes: list }),
        },
      );
      if (sessionRef.current !== sid) return;
      setView((v) => {
        const next = v ? { ...v, outcomes: res.outcomes } : v;
        viewRef.current = next;
        return next;
      });
    } catch {
      // 记不下只影响对话里的留痕
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const h = await fetchJson<{ sessions: DesignRecord[] }>("/api/agents/design");
    const list = [...h.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setHistory(list);
    return list;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void loadHistory().catch((err) => setError(errorText(err)));
  }, [enabled, loadHistory]);

  // 没指定设计记录时,自动接着本智能体最近一次设计
  useEffect(() => {
    if (!enabled || autoPicked.current || !history || !agentId) return;
    autoPicked.current = true;
    const latest = history.find((s) => s.designTargetAgentId === agentId);
    if (latest) {
      setSessionId(latest.id);
      cb.current.onSessionChange(latest.id);
    }
  }, [enabled, history, agentId]);

  /** 最近一次没有冲突时的基线:设计器的提议是相对它的(冲突后 base 已是目标的新内容) */
  const baselineRef = useRef<DesignDraft | null>(null);
  const accept = useCallback((next: DesignView) => {
    viewRef.current = next;
    if (!next.conflict && !next.legacy && next.base) baselineRef.current = next.base;
    setView(next);
  }, []);

  const inspect = useCallback(
    (id = sessionRef.current) => fetchJson<DesignView>(`/api/agents/design/${id}`),
    [],
  );

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      const next = await fetchJson<DesignView>(
        `/api/agents/design/${sessionRef.current}`,
        json(body),
      );
      accept(next);
      return next;
    },
    [accept],
  );

  /**
   * 档案自动保存改了目标智能体之后,设计会话的基线就旧了(预览显示 conflict)。
   * 这是自己造成的:载入当前草稿建立新基线,再把设计器还没确认的那几节提议放回去 ——
   * 提议仍是「待确认」,差异按最新内容重新计算,用户确认前看得到。别人改的照样走 conflict 提示。
   */
  const rebaseIfNeeded = useCallback(
    async (cur: DesignView): Promise<DesignView> => {
      if (!selfSaved.current || !cur.conflict || cur.legacy || cur.busy || !cur.draft || !cur.base)
        return cur;
      selfSaved.current = false;
      const proposal = cur.draft;
      // 和冲突前的基线比,才分得清哪些是设计器的提议、哪些是刚才档案里自己改的
      const secs = changedSections(baselineRef.current ?? cur.base, proposal);
      const ids = cur.resourceAgentIds;
      let v = await patch({ reset: true, revision: cur.revision });
      if (ids && JSON.stringify(ids) !== JSON.stringify(v.resourceAgentIds ?? [])) {
        v = await patch({ revision: v.revision, resourceAgentIds: ids });
      }
      if (secs.length && v.base) {
        v = await patch({
          revision: v.revision,
          draft: mergeDesignSections(v.base, proposal, secs),
        });
      }
      return v;
    },
    [patch],
  );

  const refresh = useCallback(async () => {
    if (!sessionRef.current) return null;
    const next = await inspect();
    accept(next);
    return rebaseIfNeeded(next);
  }, [inspect, accept, rebaseIfNeeded]);

  const watch = useCallback(
    async (
      id: string,
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
        await followRun({ sessionId: id, runId, push: batch.push, signal: abort.signal, initial });
      } finally {
        batch.flush();
        if (seq === sequence.current && !abort.signal.aborted) {
          setTurns((all) => all.map((t) => (t.runId === runId ? { ...t, running: false } : t)));
          setRunning(false);
          runIdRef.current = undefined;
          const next = await fetchJson<DesignView>(`/api/agents/design/${id}`);
          accept(next);
          await rebaseIfNeeded(next).catch(() => {});
          void loadHistory().catch(() => {});
        }
      }
    },
    [accept, loadHistory, rebaseIfNeeded],
  );

  useEffect(() => {
    streamRef.current?.abort();
    const seq = ++sequence.current;
    setRunning(false);
    setTurns([]);
    setView(null);
    viewRef.current = null;
    setError("");
    setPendingQuestions([]);
    // 换了设计会话:上一个会话工作区里的附件不能带到这里
    setCarried((cur) => (cur.length ? [] : cur));
    if (!enabled || !sessionId) return;
    const abort = new AbortController();
    streamRef.current = abort;
    setLoading(true);
    void Promise.all([
      fetchJson<DesignView>(`/api/agents/design/${sessionId}`),
      fetchJson<{ turns: Turn[]; activeRunId?: string }>(`/api/sessions/${sessionId}/history`),
    ])
      .then(async ([next, conversation]) => {
        if (seq !== sequence.current) return;
        accept(next);
        setTurns(conversation.turns);
        if (conversation.activeRunId) {
          setRunning(true);
          runIdRef.current = conversation.activeRunId;
          void watch(sessionId, conversation.activeRunId, abort).catch((err) =>
            setError(errorText(err)),
          );
        }
      })
      .catch((err) => {
        if (seq === sequence.current) setError(errorText(err));
      })
      .finally(() => {
        if (seq === sequence.current) setLoading(false);
      });
    return () => abort.abort();
  }, [enabled, sessionId, accept, watch]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /** 页面已经换走(切到别的智能体)后,晚到的响应不能再改地址 */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const select = useCallback((id: string) => {
    if (!mounted.current) return;
    autoPicked.current = true;
    setSessionId(id);
    cb.current.onSessionChange(id || null);
  }, []);

  /** 新建设计会话(有目标时导出它的当前定义) */
  const createSession = useCallback(async () => {
    const created = await fetchJson<{ sessionId: string }>("/api/agents/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentId ? { agentId } : {}),
    });
    select(created.sessionId);
    sessionRef.current = created.sessionId;
    await loadHistory().catch(() => {});
    return created.sessionId;
  }, [agentId, select, loadHistory]);

  const create = useCallback(() => act(createSession), [act, createSession]);

  const send = useCallback(
    async (text = prompt, opts: { attach?: File[]; uploaded?: string[] } = {}) => {
      const attach = opts.attach ?? [];
      const uploaded = opts.uploaded ?? [];
      const content =
        text.trim() || (attach.length || uploaded.length ? "请根据附件设计这个智能体。" : "");
      if (!content || blocked) return false;
      return act(async () => {
        let id = sessionRef.current;
        let current = viewRef.current;
        if (!id) {
          id = await createSession();
          current = await inspect(id);
          accept(current);
        }
        if (!current || current.legacy) throw new Error("旧设计没有保存基线，先载入当前草稿");
        current = await rebaseIfNeeded(current);
        const names = [...new Set([...uploaded, ...(await uploadDesignFiles(id, attach))])];
        if (attach.length) {
          const sent = new Set(attach);
          setFiles((cur) => cur.filter((f) => !sent.has(f)));
          filesRef.current = filesRef.current.filter((f) => !sent.has(f));
        }
        setCarried(names);
        const runPrompt = joinPromptAttachments(content, names);
        const abort = new AbortController();
        streamRef.current = abort;
        const response = await fetch(`/api/agents/design/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: runPrompt, revision: current.revision }),
          signal: abort.signal,
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        const runId = response.headers.get("X-Run-Id");
        if (!runId || !response.body) throw new Error("运行未返回事件流");
        runIdRef.current = runId;
        setTurns((all) => [
          ...all,
          {
            runId,
            prompt: runPrompt,
            events: [],
            running: true,
            startedAt: new Date().toISOString(),
          },
        ]);
        setPrompt((p) => (p.trim() === text.trim() ? "" : p));
        setCarried([]);
        setRunning(true);
        void watch(id, runId, abort, response.body).catch((err) => setError(errorText(err)));
      });
    },
    [prompt, blocked, act, createSession, inspect, accept, rebaseIfNeeded, watch],
  );

  const stop = useCallback(async () => {
    if (!runIdRef.current) return;
    await act(async () => {
      await fetchJson(`/api/sessions/${sessionRef.current}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: runIdRef.current }),
      });
      // 继续等终态事件,不把取消 HTTP 成功误当成已经安全结束文件写入。
    });
  }, [act]);

  const submitAnswer = useCallback<SubmitAnswer>(async (approvalId, body) => {
    if (!sessionRef.current) return;
    await fetchJson(`/api/sessions/${sessionRef.current}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        "decline" in body
          ? { approvalId, decision: "denied" }
          : { approvalId, decision: "approved", answers: body.answers },
      ),
    });
    setApprovalRefresh((n) => n + 1);
  }, []);

  const postApply = useCallback(async (previewToken: string | undefined) => {
    return fetchJson<{ agent: { id: string; name: string }; created: boolean }>(
      "/api/agents/design/apply",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionRef.current, previewToken }),
      },
    );
  }, []);

  /**
   * 按节应用(A4):先存档案、确认基线最新,把「基线 + 这一节的提议」写回设计会话,
   * 核对新预览里的差异正是用户刚才看到的那一节(不是就停下让用户重看),再用它的 previewToken 保存;
   * 剩下没确认的节放回设计会话,仍然待确认。
   */
  const applySection = useCallback(
    async (section: DesignSection) => {
      setWorking(section);
      const shown = viewRef.current?.changes ?? [];
      const ok = await act(async () => {
        if (!(await cb.current.beforeApply()))
          throw new Error("档案里还有没保存的修改（或暂停了保存），先处理好再应用");
        let cur = await inspect();
        accept(cur);
        cur = await rebaseIfNeeded(cur);
        if (cur.legacy || !cur.draft || !cur.base)
          throw new Error("旧设计没有保存基线，先载入当前草稿");
        if (cur.conflict)
          throw new Error("目标智能体已被修改，当前设计不能直接覆盖；载入当前草稿后重新设计");
        const proposal = cur.draft;
        const pendingSecs = changedSections(cur.base, proposal);
        // 新建(还没有目标)时名称必须一起保存
        const requireIdentity = !cur.targetId;
        const applied = new Set<DesignSection>([section]);
        // 新建时名称与提示词是保存的必填项,一起带上
        if (requireIdentity) {
          applied.add("identity");
          applied.add("prompt");
        }
        const partial = mergeDesignSections(cur.base, proposal, [...applied]);
        const target = await patch({ revision: cur.revision, draft: partial });
        const restore = () => patch({ revision: target.revision, draft: proposal }).catch(() => {});
        if (target.conflict || target.issues?.length || !target.previewToken) {
          const issues = target.issues?.map((i) => `${i.field}: ${i.message}`).join("；");
          await restore();
          throw new Error(issues ? `这一节有校验问题：${issues}` : "预览没有就绪，稍后再试");
        }
        const key = (cs: SnapshotChange[]) =>
          JSON.stringify(
            cs
              .filter((c) => applied.has(sectionOfChangePath(c.path)))
              .map((c) => c.path)
              .sort(),
          );
        if (key(target.changes ?? []) !== key(shown)) {
          await restore();
          throw new Error("设计器的改动刚刚变了，请重新查看后再应用");
        }
        const result = await postApply(target.previewToken);
        await recordOutcomes(
          groupChanges(shown)
            .filter((g) => applied.has(g.section))
            .map((g) => ({ section: g.section, count: g.changes.length, applied: true })),
        );
        const after = await inspect();
        accept(after);
        const rest = pendingSecs.filter((s) => !applied.has(s));
        if (rest.length && after.base) {
          await patch({
            revision: after.revision,
            draft: mergeDesignSections(after.base, proposal, rest),
          });
        }
        void loadHistory().catch(() => {});
        await cb.current.onApplied({
          agentId: result.agent.id,
          created: result.created,
          sections: [...applied],
        });
      });
      setWorking(null);
      return ok;
    },
    [act, inspect, accept, rebaseIfNeeded, patch, postApply, loadHistory, recordOutcomes],
  );

  /** 整体「差异与保存」:用弹层里展示的那份预览的 token 保存(服务端核对冲突与 token) */
  const applyAll = useCallback(
    async (previewToken: string | undefined) => {
      setWorking("all");
      const cur = viewRef.current;
      const sections = cur?.draft && cur.base ? changedSections(cur.base, cur.draft) : [];
      const ok = await act(async () => {
        if (!(await cb.current.beforeApply()))
          throw new Error("档案里还有没保存的修改（或暂停了保存），先处理好再保存");
        const result = await postApply(previewToken);
        await recordOutcomes(
          groupChanges(cur?.changes ?? []).map((g) => ({
            section: g.section,
            count: g.changes.length,
            applied: true,
          })),
        );
        accept(await inspect());
        void loadHistory().catch(() => {});
        await cb.current.onApplied({ agentId: result.agent.id, created: result.created, sections });
      });
      setWorking(null);
      return ok;
    },
    [act, postApply, accept, inspect, loadHistory, recordOutcomes],
  );

  /** 先不改:这一节退回基线(提议丢掉,对话保留) */
  const rejectSection = useCallback(
    async (section: DesignSection) => {
      setWorking(section);
      await act(async () => {
        const cur = viewRef.current;
        if (!cur?.draft || !cur.base) return;
        const count = groupChanges(cur.changes ?? []).find((g) => g.section === section)?.changes
          .length;
        await patch({
          revision: cur.revision,
          draft: mergeDesignSections(cur.draft, cur.base, [section]),
        });
        await recordOutcomes([{ section, count: count ?? 0, applied: false }]);
      });
      setWorking(null);
    },
    [act, patch, recordOutcomes],
  );

  /** 载入当前草稿(legacy / conflict):替换设计草稿,对话保留 */
  const resetToCurrent = useCallback(
    () =>
      act(async () => {
        selfSaved.current = false;
        await patch({ reset: true, revision: viewRef.current?.revision });
      }),
    [act, patch],
  );

  /** 档案自动保存成功(或版本载入草稿)之后调用:让设计基线跟上 */
  const notifyTargetChanged = useCallback(() => {
    if (!sessionRef.current || !viewRef.current?.targetId) return;
    selfSaved.current = true;
    if (running || busy) return;
    void (async () => {
      try {
        const next = await inspect();
        accept(next);
        await rebaseIfNeeded(next);
      } catch {
        // 下次操作时会再试
      }
    })();
  }, [running, busy, inspect, accept, rebaseIfNeeded]);

  /** 新建态:档案手填先建出了智能体,没有目标的设计会话认领它 */
  const bindTarget = useCallback(
    async (id: string) => {
      const cur = viewRef.current;
      if (!sessionRef.current || !cur || cur.targetId || cur.legacy) return;
      await act(() => patch({ revision: cur.revision, bindTarget: id }));
    },
    [act, patch],
  );

  /** Skills / MCP 来源(从其他智能体引用;同名冲突由界面禁用) */
  const ensureView = useCallback(async () => {
    if (!sessionRef.current) {
      await createSession();
      const v = await inspect();
      accept(v);
      return v;
    }
    return viewRef.current ?? (await refresh());
  }, [createSession, inspect, accept, refresh]);

  const changeSources = useCallback(
    (ids: string[]) =>
      act(async () => {
        const cur = await ensureView();
        if (!cur?.draft) throw new Error("设计会话还没准备好");
        const keep = (refs: string[]) =>
          refs.filter((r) => {
            try {
              return ids.includes((JSON.parse(r) as string[])[0] ?? "");
            } catch {
              return false;
            }
          });
        await patch({
          revision: cur.revision,
          resourceAgentIds: ids,
          draft: {
            ...cur.draft,
            skillRefs: keep(cur.draft.skillRefs),
            mcpRefs: keep(cur.draft.mcpRefs),
          },
        });
      }),
    [act, ensureView, patch],
  );

  const toggleRef = useCallback(
    (kind: "skill" | "mcp", ref: string, on: boolean) =>
      act(async () => {
        const cur = viewRef.current;
        if (!cur?.draft) return;
        const key = kind === "skill" ? "skillRefs" : "mcpRefs";
        const list = cur.draft[key];
        await patch({
          revision: cur.revision,
          draft: { ...cur.draft, [key]: on ? [...list, ref] : list.filter((r) => r !== ref) },
        });
      }),
    [act, patch],
  );

  const loadTrialRuns = useCallback(async (): Promise<TrialRun[]> => {
    if (!sessionRef.current) return [];
    const res = await fetch(`/api/agents/design/${encodeURIComponent(sessionRef.current)}/runs`);
    if (!res.ok) return [];
    return ((await res.json()) as { runs: TrialRun[] }).runs;
  }, []);

  /** 上一轮没有完成(aiIssue):把那一轮的话再发一次 */
  const retry = useCallback(() => {
    const last = turnsRef.current.at(-1);
    return last ? send(last.prompt) : Promise.resolve(false);
  }, [send]);

  // 带描述进来:会话载入后还没有任何轮次,自动把描述发给设计器(只试一次;失败照常显示错误)
  const autoTried = useRef(false);
  const autoPrompt = opts.initialPrompt;
  useEffect(() => {
    if (
      !enabled ||
      !shouldAutoSend({
        desc: autoPrompt,
        sessionId,
        loading,
        hasView: view !== null,
        turnCount: turns.length,
        attempted: autoTried.current,
        blocked,
      })
    )
      return;
    autoTried.current = true;
    void send(autoPrompt, { uploaded: cb.current.initialFiles }).finally(() =>
      cb.current.onAutoSent?.(),
    );
  }, [enabled, autoPrompt, sessionId, loading, view, turns.length, blocked, send]);

  const pending = useMemo(() => groupChanges(view?.changes ?? []), [view?.changes]);
  const records = useMemo(
    () =>
      (history ?? []).filter(
        (s) =>
          s.id === sessionId ||
          (agentId ? s.designTargetAgentId === agentId : !s.designTargetAgentId),
      ),
    [history, sessionId, agentId],
  );

  return {
    sessionId,
    records,
    historyLoaded: history !== null,
    view,
    turns,
    running,
    busy,
    loading,
    blocked,
    working,
    error,
    setError,
    prompt,
    setPrompt,
    files,
    addFiles,
    removeFile,
    /** 发送输入框里的文字与附件 */
    /** 已传进工作区、还没随消息发出去的附件 */
    carried,
    dropCarried: (name: string) => setCarried((cur) => cur.filter((n) => n !== name)),
    sendInput: () => send(prompt, { attach: files, uploaded: carried }),
    pendingQuestions,
    setPendingQuestions,
    approvalRefresh,
    submitAnswer,
    pending,
    select,
    create,
    send,
    retry,
    outcomes: view?.outcomes ?? EMPTY_OUTCOMES,
    stop,
    refresh: () => act(refresh),
    applySection,
    applyAll,
    rejectSection,
    resetToCurrent,
    notifyTargetChanged,
    bindTarget,
    changeSources,
    toggleRef,
    loadTrialRuns,
  };
}

export type Designer = ReturnType<typeof useDesigner>;
