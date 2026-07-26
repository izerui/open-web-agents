// 重跑的锚点逻辑。纯逻辑,零 IO。
//
// 【SDK 能力边界 —— 实测确认】
// claude-agent-sdk 的 session_id 标识【整个会话】,不是某个时间点的快照:
// 同一会话连跑两轮,两轮返回的 session_id 完全相同,resume 它得到的是【最新】状态。
// 因此"回到第 2 轮之前、换个说法重做"用 session id 做不到 —— 那样实现出来会是
// 一个看起来像分支、实际仍在主线上继续的假功能,比没有更糟。
//
// 所以只提供两种【语义真实】的重跑:
//   · fresh    —— 不 resume,从零重开。跑歪了想换个说法重来时用,上下文干净
//   · continue —— resume 当前会话状态,等价于追加一轮
//
// 每次运行仍逐轮记录 resumeAnchor 与 sdkSessionId:一是可审计(这轮从哪儿起跑),
// 二是 parentRunId 能把"这是那一轮的重跑"如实呈现给用户。
// 真正的历史分叉需要 SDK 支持从截断的 transcript 派生新会话,当前版本没有这个能力。

export interface RunAnchor {
  id: string;
  /** 这一轮开始时 resume 的 SDK 会话;首轮为空。 */
  resumeAnchor?: string;
  /** 这一轮跑完产生的 SDK 会话;未成功完成则为空。 */
  sdkSessionId?: string;
  parentRunId?: string;
}

export type BranchMode = "fresh" | "continue";

export type AnchorResult =
  | { ok: true; resumeAnchor?: string; parentRunId: string }
  | { ok: false; reason: string };

/**
 * 算出重跑运行应当使用的 resume 锚点。
 *
 * fresh:不 resume,从零重开 —— 锚点恒为空,任何目标轮都能这么重跑(含失败的轮次)。
 * continue:resume 目标轮产生的会话;该轮没跑出 sdkSessionId 就无处可接。
 */
export function anchorForBranch(target: RunAnchor, mode: BranchMode): AnchorResult {
  if (mode === "fresh") {
    return { ok: true, resumeAnchor: undefined, parentRunId: target.id };
  }

  if (!target.sdkSessionId) {
    return {
      ok: false,
      reason: "该轮没有产生可续接的会话状态(可能失败或被中断),无法从它之后继续",
    };
  }
  return { ok: true, resumeAnchor: target.sdkSessionId, parentRunId: target.id };
}

/**
 * 从运行列表里理出一条分支链:从某个运行回溯到根。
 * 用于界面展示"这一支是怎么来的"。
 */
export function lineageOf(runId: string, runs: RunAnchor[]): RunAnchor[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const chain: RunAnchor[] = [];
  const seen = new Set<string>();

  let cur = byId.get(runId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); // 数据异常形成环时不至于死循环
    chain.unshift(cur);
    cur = cur.parentRunId ? byId.get(cur.parentRunId) : undefined;
  }
  return chain;
}

/** 某个运行是否有分支(被别的运行当作父)。界面据此显示分叉标记。 */
export function hasBranches(runId: string, runs: RunAnchor[]): boolean {
  return runs.some((r) => r.parentRunId === runId);
}
