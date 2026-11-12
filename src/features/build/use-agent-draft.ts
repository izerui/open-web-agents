"use client";

// 档案草稿与自动保存(gaps A3)。字段停顿 800ms 后保存(POST /api/agents,以已加载的完整配置为底
// 只覆盖表单字段,与原 Builder 同一保存语义);被闸门挡住时暂停并说明原因;离开页面时有未落盘的修改照旧提醒。
// 规则在 autosave.ts / profile-model.ts,这里只负责计时、请求与提醒。

import { BEFORE_CLIENT_NAVIGATION } from "@/lib/client-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTOSAVE_DELAY_MS,
  type AutosaveEvent,
  type AutosaveState,
  INITIAL_AUTOSAVE,
  autosaveStep,
} from "./autosave";
import {
  EMPTY_DRAFT,
  type LoadedAgent,
  type ProfileDraft,
  draftFromAgent,
  saveBlock,
  saveBodyOf,
} from "./profile-model";

export interface SavedAgent extends LoadedAgent {
  ownerId?: string;
}

export function useAgentDraft(opts: {
  /** 已有的智能体;新建时为 null */
  agent: LoadedAgent | null;
  canManageWebhook: boolean;
  takenIds: readonly string[];
  /** 保存成功;created = 这次保存新建了智能体 */
  onSaved: (saved: SavedAgent, created: boolean) => void;
}) {
  const cb = useRef(opts);
  cb.current = opts;
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    opts.agent ? draftFromAgent(opts.agent) : EMPTY_DRAFT,
  );
  const draftRef = useRef(draft);
  const loadedRef = useRef<Record<string, unknown>>(opts.agent?.config ?? {});
  const createdRef = useRef<string | null>(opts.agent?.id ?? null);
  const savedJsonRef = useRef(JSON.stringify(draft));
  const [savedJson, setSavedJson] = useState(savedJsonRef.current);
  const [auto, setAuto] = useState<AutosaveState>(INITIAL_AUTOSAVE);
  const autoRef = useRef(auto);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedId = useRef<string | null>(opts.agent?.id ?? null);

  const blockOf = useCallback(
    (d: ProfileDraft) =>
      saveBlock(d, { isNew: createdRef.current === null, takenIds: cb.current.takenIds }),
    [],
  );

  const dispatchRef = useRef<(e: AutosaveEvent) => void>(() => {});

  const doSave = useCallback(async () => {
    const d = draftRef.current;
    const snapshot = JSON.stringify(d);
    const creating = createdRef.current === null;
    try {
      const body = saveBodyOf(d, {
        loadedConfig: loadedRef.current,
        canManageWebhook: cb.current.canManageWebhook,
        isNew: creating,
      });
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        agent?: SavedAgent;
        error?: string;
        code?: string;
      };
      if (res.status === 409 && data.code === "id_taken") throw new Error("ID 已被占用");
      if (!res.ok || !data.agent) throw new Error(data.error ?? `HTTP ${res.status}`);
      const saved = data.agent;
      loadedRef.current = saved.config;
      if (creating) {
        createdRef.current = saved.id;
        loadedId.current = saved.id;
        // 服务端生成的 ID 写回表单(之后 ID 不能再改)
        if (!d.id.trim()) {
          const withId = { ...draftRef.current, id: saved.id };
          draftRef.current = withId;
          setDraft(withId);
        }
      }
      savedJsonRef.current =
        creating && !d.id.trim() ? JSON.stringify({ ...d, id: saved.id }) : snapshot;
      setSavedJson(savedJsonRef.current);
      dispatchRef.current({
        type: "saved",
        at: Date.now(),
        blocked: blockOf(draftRef.current) !== null,
      });
      cb.current.onSaved(saved, creating);
    } catch (e) {
      dispatchRef.current({ type: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [blockOf]);

  const dispatch = useCallback(
    (e: AutosaveEvent) => {
      const r = autosaveStep(autoRef.current, e);
      autoRef.current = r.state;
      setAuto(r.state);
      if (r.effect === "schedule" || r.effect === "cancel" || r.effect === "save") {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      if (r.effect === "schedule") {
        timer.current = setTimeout(() => dispatchRef.current({ type: "timer" }), AUTOSAVE_DELAY_MS);
      }
      if (r.effect === "save") void doSave();
    },
    [doSave],
  );
  dispatchRef.current = dispatch;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** 改表单 */
  const update = useCallback(
    (fn: (d: ProfileDraft) => ProfileDraft) => {
      const next = fn(draftRef.current);
      draftRef.current = next;
      setDraft(next);
      dispatch({ type: "edit", blocked: blockOf(next) !== null });
    },
    [dispatch, blockOf],
  );
  const set = useCallback(
    (patch: Partial<ProfileDraft>) => update((d) => ({ ...d, ...patch })),
    [update],
  );

  /** 用服务端的最新内容重置表单(切换智能体、设计器应用之后、版本载入草稿之后) */
  const resetFrom = useCallback((agent: LoadedAgent) => {
    if (timer.current) clearTimeout(timer.current);
    const next = draftFromAgent(agent);
    draftRef.current = next;
    setDraft(next);
    loadedRef.current = agent.config;
    createdRef.current = agent.id;
    loadedId.current = agent.id;
    savedJsonRef.current = JSON.stringify(next);
    setSavedJson(savedJsonRef.current);
    autoRef.current = { ...INITIAL_AUTOSAVE, savedAt: autoRef.current.savedAt };
    setAuto(autoRef.current);
  }, []);

  // 打开的智能体换了(或第一次读到):从它重新开始
  useEffect(() => {
    const a = opts.agent;
    if (a && a.id !== loadedId.current) resetFrom(a);
  }, [opts.agent, resetFrom]);

  /** 立即保存;返回 true 表示表单已全部落盘 */
  const flush = useCallback(async () => {
    if (autoRef.current.phase === "pending") dispatch({ type: "flush" });
    for (let i = 0; i < 300; i++) {
      const p = autoRef.current.phase;
      if (p !== "saving" && p !== "pending") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return (
      autoRef.current.phase === "idle" && JSON.stringify(draftRef.current) === savedJsonRef.current
    );
  }, [dispatch]);

  const retry = useCallback(() => dispatch({ type: "retry" }), [dispatch]);

  const dirty = JSON.stringify(draft) !== savedJson;
  const block = useMemo(() => blockOf(draft), [draft, blockOf]);

  // 离开提醒:关闭标签、站内链接、程序化跳转都问一句(与原 Builder 一致)
  const allowNav = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    allowNav.current = false;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNav.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardInternalLink = (event: MouseEvent) => {
      if (allowNav.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank") return;
      const dest = new URL(link.href, window.location.href);
      if (dest.origin === window.location.origin && dest.pathname === window.location.pathname)
        return;
      if (!window.confirm("当前智能体有没保存的修改，确定离开并放弃这些修改？")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      allowNav.current = true;
    };
    const guardNavigation = (event: Event) => {
      if (event.defaultPrevented || allowNav.current) return;
      if (!window.confirm("当前智能体有没保存的修改，确定离开并放弃这些修改？")) {
        event.preventDefault();
        return;
      }
      if (!(event instanceof CustomEvent && event.detail?.preflightOnly)) allowNav.current = true;
    };
    window.addEventListener(BEFORE_CLIENT_NAVIGATION, guardNavigation);
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", guardInternalLink, true);
    return () => {
      window.removeEventListener(BEFORE_CLIENT_NAVIGATION, guardNavigation);
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", guardInternalLink, true);
    };
  }, [dirty]);

  return {
    draft,
    set,
    update,
    auto,
    block,
    dirty,
    flush,
    retry,
    resetFrom,
    createdId: createdRef.current,
    loadedConfig: loadedRef,
  };
}

export type AgentDraft = ReturnType<typeof useAgentDraft>;
