// 草稿自动保存(gaps A3)的状态机。纯函数:给出下一个状态和要做的事(排定计时 / 立即保存 / 取消计时),
// 计时与请求由 use-agent-draft 执行。这样「停顿 800ms 才存」「存的时候又改了就再存一次」
// 「被闸门挡住就暂停」这些规则能被单测穷举。

export const AUTOSAVE_DELAY_MS = 800;

export type AutosavePhase = "idle" | "pending" | "saving" | "blocked" | "error";

export interface AutosaveState {
  phase: AutosavePhase;
  /** 保存进行中又有改动:这次存完要再存一次 */
  queued: boolean;
  /** 上次成功保存的时刻(ms) */
  savedAt?: number;
  error?: string;
}

export type AutosaveEvent =
  /** 表单改动;blocked = 当前草稿过不了保存闸门 */
  | { type: "edit"; blocked: boolean }
  /** 防抖计时到了 */
  | { type: "timer" }
  /** 保存成功;blocked = 此刻的草稿过不了闸门 */
  | { type: "saved"; at: number; blocked: boolean }
  | { type: "failed"; error: string }
  | { type: "retry" }
  /** 立即保存(离开页面、应用设计器改动之前) */
  | { type: "flush" };

export type AutosaveEffect = "schedule" | "save" | "cancel";

export const INITIAL_AUTOSAVE: AutosaveState = { phase: "idle", queued: false };

export function autosaveStep(
  s: AutosaveState,
  e: AutosaveEvent,
): { state: AutosaveState; effect?: AutosaveEffect } {
  switch (e.type) {
    case "edit":
      if (s.phase === "saving") return { state: { ...s, queued: true } };
      if (e.blocked)
        return { state: { ...s, phase: "blocked", error: undefined }, effect: "cancel" };
      return { state: { ...s, phase: "pending", error: undefined }, effect: "schedule" };
    case "timer":
      return s.phase === "pending"
        ? { state: { ...s, phase: "saving" }, effect: "save" }
        : { state: s };
    case "flush":
      return s.phase === "pending"
        ? { state: { ...s, phase: "saving" }, effect: "save" }
        : { state: s };
    case "saved": {
      const base = { ...s, savedAt: e.at, queued: false, error: undefined };
      if (!s.queued) return { state: { ...base, phase: "idle" } };
      if (e.blocked) return { state: { ...base, phase: "blocked" } };
      return { state: { ...base, phase: "pending" }, effect: "schedule" };
    }
    case "failed":
      return { state: { ...s, phase: "error", queued: false, error: e.error } };
    case "retry":
      return s.phase === "error"
        ? { state: { ...s, phase: "saving" }, effect: "save" }
        : { state: s };
  }
}
