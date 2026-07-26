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
  // 先查行再取列 —— cur 来自 `row.status as RunState`,而 RunState 只是编译期类型,
  // 数据库那一列是 varchar(16)。库里出现五个已知状态之外的值(手工改库、迁移只应用了
  // 一半)时,直接 TABLE[cur][sig] 会抛 "Cannot read properties of undefined",
  // 与正常的非法迁移混作一谈;调用方对两者一视同仁地吞掉,数据损坏就此无从诊断。
  const row = TABLE[cur];
  if (!row) throw new Error(`unknown run state from storage: ${JSON.stringify(cur)}`);
  const next = row[sig];
  if (!next) throw new Error(`illegal transition: ${cur} --${sig}-->`);
  return next;
}

/** 终态不可再迁移。 */
export function isTerminal(s: RunState): boolean {
  return s === "success" || s === "failed" || s === "cancelled";
}
