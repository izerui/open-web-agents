import type { RunSignal, RunState } from "@/lib/shared";

/** 状态迁移表。集中管控合法性,防非法态扩散。 */
const TABLE: Record<RunState, Partial<Record<RunSignal, RunState>>> = {
  pending: { claim: "running", cancel: "cancelled" },
  running: { finishOk: "success", finishErr: "failed", cancel: "cancelled" },
  success: {},
  failed: {},
  cancelled: {},
};

export function nextRunState(cur: RunState, sig: RunSignal): RunState {
  const next = TABLE[cur][sig];
  if (!next) throw new Error(`illegal transition: ${cur} --${sig}-->`);
  return next;
}

/** 终态不可再迁移。 */
export function isTerminal(s: RunState): boolean {
  return s === "success" || s === "failed" || s === "cancelled";
}
