// 重跑的锚点逻辑。纯逻辑,零 IO。
//
// 【SDK 能力边界 —— 实测确认】
// claude-agent-sdk 的 session_id 标识【整个会话】,不是某个时间点的快照:同一会话连跑两轮,
// 两轮的 session_id 完全相同、写进同一份 transcript,只按 session id 续接得到的是【最新】状态。
// 要回到中间某一轮,得同时给出"在哪条消息之后接着跑"(resumeSessionAt),并分到新会话
// (forkSession)—— scripts/sdk-probe/branch-resume-at.mjs 实测:模型只看到那条消息之前的对话,
// 原会话不受影响。
//
// 三种重跑:
//   · fresh    —— 不 resume,从零重开。上下文干净
//   · continue —— resume 当前会话状态,等价于追加一轮
//   · rewind   —— 回到目标那一轮【之前】的状态重来:之前的对话都在,那一轮及之后的都不在。
//                 需要知道目标前一轮的最后一条消息(每轮记下的 transcript 范围);
//                 旧数据没有这个记录时如实拒绝,不猜
//
// 每次运行仍逐轮记录 resumeAnchor 与 sdkSessionId:一是可审计(这轮从哪儿起跑),
// 二是 parentRunId 能把"这是那一轮的重跑"如实呈现给用户。

export interface RunAnchor {
  id: string;
  /** 这一轮开始时 resume 的 SDK 会话;首轮为空。 */
  resumeAnchor?: string;
  /** 这一轮是从 resumeAnchor 里哪条消息之后接着跑的("从某一轮重来"的分支才有)。 */
  resumeAt?: string;
  /** 本轮在 transcript 里的首尾消息 uuid(旧数据没有)。 */
  transcriptRange?: { first: string; last: string };
  createdAt?: number;
  /** 这一轮跑完产生的 SDK 会话;未成功完成则为空。 */
  sdkSessionId?: string;
  parentRunId?: string;
}

export type BranchMode = "fresh" | "continue" | "rewind";

export type AnchorResult =
  | { ok: true; resumeAnchor?: string; resumeAt?: string; parentRunId: string }
  | { ok: false; reason: string; code?: "rewind_unavailable" };

/**
 * 算出重跑运行应当使用的 resume 锚点。
 *
 * fresh:不 resume,从零重开 —— 锚点恒为空,任何目标轮都能这么重跑(含失败的轮次)。
 * continue:resume 目标轮产生的会话;该轮没跑出 sdkSessionId 就无处可接。
 */
export function anchorForBranch(
  target: RunAnchor,
  mode: BranchMode,
  /** 本会话的全部运行 —— rewind 要从中找出目标的前一轮 */
  all: RunAnchor[] = [],
): AnchorResult {
  if (mode === "fresh") {
    return { ok: true, resumeAnchor: undefined, parentRunId: target.id };
  }
  if (mode === "rewind") return rewindTo(target, all);

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

/**
 * 目标那一轮【之前】的状态。
 *
 * - 目标本身是从零开始的(首轮,或 fresh 分支):之前没有对话,等同从零重开
 * - 目标本身就是"从某一轮重来"的分支:它之前的状态就是它自己的起点
 * - 否则:目标续接的那份会话里,在它之前的最后一轮的最后一条消息
 *   (同一 session id 的各轮在同一份文件里依次排列;fork 出去的分支是另一个 id)
 */
function rewindTo(target: RunAnchor, all: RunAnchor[]): AnchorResult {
  const base = { ok: true as const, parentRunId: target.id };
  if (!target.resumeAnchor) return { ...base, resumeAnchor: undefined };
  if (target.resumeAt) {
    return { ...base, resumeAnchor: target.resumeAnchor, resumeAt: target.resumeAt };
  }
  const before = all
    .filter(
      (r) =>
        r.id !== target.id &&
        r.sdkSessionId === target.resumeAnchor &&
        (r.createdAt ?? 0) < (target.createdAt ?? 0),
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  if (!before?.transcriptRange) {
    return {
      ok: false,
      code: "rewind_unavailable",
      reason: "无法精确定位这一轮之前的对话状态(较早的运行没有记录),只能从零重开或接着最新状态继续",
    };
  }
  return { ...base, resumeAnchor: target.resumeAnchor, resumeAt: before.transcriptRange.last };
}
