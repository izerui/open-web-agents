// 构建页的纯逻辑:阶段与地址、页头五个阶段的状态徽标、上线清单(gaps A8)与评测结论文案。

import type { EvalAssertionsBody } from "@/features/builder/eval-form";
import type { AgentStage } from "@/lib/nav/routes";

export type Stage = "orch" | AgentStage;

export const STAGES: readonly { key: Stage; label: string }[] = [
  { key: "orch", label: "编排" },
  { key: "eval", label: "评测" },
  { key: "publish", label: "发布" },
  { key: "access", label: "接入" },
  { key: "runs", label: "运行" },
];

export function stageFromParam(p: string | null | undefined): Stage {
  return p === "eval" || p === "publish" || p === "access" || p === "runs" ? p : "orch";
}

/** 编排是默认阶段,不写进地址 */
export function stageParam(s: Stage): AgentStage | undefined {
  return s === "orch" ? undefined : s;
}

/** 某一版(或草稿)的评测结论,见服务端 eval/domain/release-gate.ts */
export interface EvalBrief {
  id: string;
  passed: number;
  total: number;
  createdAt: number;
  finishedAt?: number;
}
export interface EvalSummary {
  state: "no_cases" | "none" | "running" | "cases_changed" | "failed" | "passed";
  run?: EvalBrief;
  /** 草稿这份内容没评测过时,最近一次评测(配置已变化,不代表当前内容) */
  previous?: EvalBrief;
}

export type Tone = "" | "ok" | "warn" | "bad";
export type Badge = { text: string; tone: Tone };

export interface BadgeInput {
  readOnly: boolean;
  /** 名称与提示词都填了 */
  ready: boolean;
  /** 已填的节数(满 9) */
  filled: number;
  caseCount: number;
  /** 草稿的评测结论;还没读到为 null */
  draftEval: EvalSummary | null;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  /** 草稿与发布版的差异条数;没读到为 null */
  changeCount: number | null;
  keyCount: number;
  runs7d: number;
}

function evalBadge(e: EvalSummary | null, cases: number): Badge {
  if (!e) return { text: cases ? `${cases} 个用例` : "无用例", tone: "" };
  switch (e.state) {
    case "no_cases":
      return { text: "无用例", tone: "" };
    case "none":
      return e.previous
        ? { text: "需重跑", tone: "warn" }
        : { text: `${cases} 个未运行`, tone: "" };
    case "running":
      return { text: "运行中", tone: "warn" };
    case "cases_changed":
      return { text: "用例已改动", tone: "warn" };
    case "failed":
      return { text: `${e.run?.passed ?? 0}/${e.run?.total ?? cases} 通过`, tone: "bad" };
    case "passed":
      return { text: `${e.run?.total ?? cases}/${e.run?.total ?? cases} 通过`, tone: "ok" };
  }
}

export function stageBadges(i: BadgeInput): Record<Stage, Badge> {
  const v = i.publishedVersion;
  return {
    orch: i.readOnly
      ? { text: "只读", tone: "" }
      : i.ready
        ? { text: "完整", tone: "ok" }
        : { text: `${i.filled}/9 节`, tone: "" },
    eval: evalBadge(i.draftEval, i.caseCount),
    publish:
      v === null
        ? { text: "未发布", tone: "" }
        : i.hasUnpublishedChanges
          ? {
              text: i.changeCount ? `v${v}，${i.changeCount} 处修改` : `v${v}，有修改`,
              tone: "warn",
            }
          : { text: `v${v} 已发布`, tone: "ok" },
    access: i.keyCount > 0 ? { text: "Key 已签发", tone: "ok" } : { text: "未签 Key", tone: "" },
    runs: { text: `${i.runs7d} 次`, tone: "" },
  };
}

/** 发布区里草稿评测状态的说明;发布要求 passed */
export function draftEvalText(e: EvalSummary | null, cases: number): string {
  if (!e) return "正在读取评测结论…";
  const r = e.run;
  switch (e.state) {
    case "passed":
      return "针对当前草稿，之后没改过配置或用例";
    case "failed":
      return `当前草稿 ${r?.passed}/${r?.total} 通过，有用例未通过`;
    case "running":
      return "正在运行，每 3 秒刷新";
    case "cases_changed":
      return "用例改动过，需要对当前草稿重跑";
    case "no_cases":
      return "还没有用例，至少需要 1 个";
    case "none":
      return e.previous
        ? `配置变了，上次评测（${e.previous.passed}/${e.previous.total}）不代表当前草稿，需要重跑`
        : `${cases} 个用例还没对当前草稿运行`;
  }
}

/** 版本列表里那一版的评测标记 */
export function versionEvalText(e: EvalSummary | undefined): string {
  const r = e?.run;
  switch (e?.state) {
    case "passed":
      return `评测 ${r?.passed}/${r?.total} 通过`;
    case "failed":
      return `评测 ${r?.passed}/${r?.total}`;
    case "cases_changed":
      return `评测 ${r?.passed}/${r?.total}，用例已改动`;
    case "running":
      return "评测中";
    case "no_cases":
      return "无用例";
    default:
      return "未评测";
  }
}

export type LaunchKey = "orch" | "eval" | "changes" | "publish" | "access";
export type LaunchTarget = Stage | "fix" | "diff";

export interface LaunchItem {
  key: LaunchKey;
  ok: boolean;
  title: string;
  detail: string;
  /** 不满足时就地「去处理」 */
  action?: { label: string; to: LaunchTarget };
  /** 满足时的附加操作(查看差异) */
  alt?: { label: string; to: LaunchTarget };
}

export interface LaunchInput {
  ready: boolean;
  filled: number;
  caseCount: number;
  draftEval: EvalSummary | null;
  publishedVersion: number | null;
  nextVersion: number;
  hasUnpublishedChanges: boolean;
  changeCount: number | null;
  /** 本次在清单里刚发布的版本 */
  justPublished: number | null;
  keyCount: number;
  /** 草稿还有没落盘的修改(正在自动保存) */
  saving: boolean;
}

export function launchChecklist(i: LaunchInput): {
  items: LaunchItem[];
  readyCount: number;
  canPublish: boolean;
  publishHint: string;
} {
  const v = i.publishedVersion;
  const hasChanges = v === null || i.hasUnpublishedChanges;
  const evalOk = i.draftEval?.state === "passed";
  const total = i.draftEval?.run?.total ?? i.caseCount;
  const published = i.justPublished !== null;
  const items: LaunchItem[] = [
    {
      key: "orch",
      ok: i.ready,
      title: "编排完整",
      detail: i.ready
        ? i.filled >= 9
          ? "名称、提示词、模型等 9 节都已填写"
          : `必填项已齐；还有 ${9 - i.filled} 节没填（可选）`
        : "名称和提示词是必填项",
      action: { label: "去处理", to: "orch" },
    },
    {
      key: "eval",
      ok: evalOk,
      title: evalOk ? `评测 ${total}/${total} 通过` : "评测全部通过",
      detail: draftEvalText(i.draftEval, i.caseCount),
      action:
        i.draftEval?.state === "failed"
          ? { label: "去修复", to: "fix" }
          : { label: "去处理", to: "eval" },
    },
    {
      key: "changes",
      ok: published || hasChanges,
      title: published ? "草稿与发布版一致" : hasChanges ? "有修改可发布" : "没有可发布的修改",
      detail: published
        ? `v${i.justPublished} 就是当前草稿`
        : v === null
          ? "首次发布"
          : hasChanges
            ? i.changeCount
              ? `草稿与 v${v} 有 ${i.changeCount} 处差异`
              : `草稿与 v${v} 有差异`
            : "草稿和当前发布版相同",
      alt: !published && v !== null && hasChanges ? { label: "查看差异", to: "diff" } : undefined,
    },
    {
      key: "publish",
      ok: published,
      title: published ? `已发布 v${i.justPublished}` : `发布 v${i.nextVersion}`,
      detail: published
        ? "调用方与其他使用者从现在起用这一版；进行中的会话不受影响"
        : v !== null
          ? `发布后调用方用 v${i.nextVersion}，可用 version 参数锁定旧版`
          : "未发布时，接口调用和其他人使用都直接跑草稿",
    },
    {
      key: "access",
      ok: i.keyCount > 0,
      title: "接入",
      detail:
        i.keyCount > 0
          ? "已签发可调用本智能体的 Key"
          : "签发一个只给本智能体用的 Key，复制代码，试调一次",
      action: { label: "去接入", to: "access" },
    },
  ];
  const gates = items.slice(0, 3).every((x) => x.ok);
  const canPublish = !published && gates && hasChanges && !i.saving;
  const publishHint = published
    ? ""
    : !hasChanges
      ? "没有可发布的修改"
      : !gates
        ? "前三项都就绪后才能发布；回滚和设为发布版不受这个限制"
        : i.saving
          ? "草稿正在保存，稍后再发布"
          : "";
  return { items, readyCount: items.filter((x) => x.ok).length, canPublish, publishHint };
}

/** 左栏「我的智能体」每一行的状态 */
export function railStatus(a: {
  id: string;
  isOwner?: boolean;
  canWrite?: boolean;
  publishedVersion?: number | null;
  hasUnpublishedChanges?: boolean;
}): Badge {
  const builtin = a.id === "default" || a.id === "agent-architect";
  if (!builtin && !a.isOwner)
    return { text: a.canWrite === false ? "分享给我，只读" : "分享给我，可编辑", tone: "" };
  const v = a.publishedVersion;
  const prefix = builtin ? "内置，" : "";
  if (!v) return { text: `${prefix}草稿，未发布`, tone: "" };
  if (a.canWrite !== false && a.hasUnpublishedChanges)
    return { text: `${prefix}v${v}，草稿有修改`, tone: "warn" };
  return { text: `${prefix}已发布 v${v}`, tone: "ok" };
}

/** 列表里一行看得懂的断言摘要(原型用「；」分隔) */
export function assertionText(a: EvalAssertionsBody): string {
  const parts: string[] = [];
  if (a.expectSuccess === false) parts.push("期望运行失败");
  for (const f of a.fieldEquals ?? []) parts.push(`${f.path} = ${JSON.stringify(f.value)}`);
  if (a.contains?.length) parts.push(`须包含${a.contains.map((s) => `「${s}」`).join("")}`);
  if (a.notContains?.length) parts.push(`不得包含${a.notContains.map((s) => `「${s}」`).join("")}`);
  if (a.maxCostUsd !== undefined) parts.push(`≤ $${a.maxCostUsd}`);
  if (a.maxDurationMs !== undefined) parts.push(`≤ ${a.maxDurationMs / 1000}s`);
  return parts.join("；") || "只要求运行成功";
}

/** 运行阶段顶部的小统计(A17):7 天调用、失败率、消耗积分(微积分,字符串) */
export function runStats(u: {
  totals?: { runs?: number; failed?: number };
  runs?: { estimatedCredits?: { totalMicroCredits?: string } | null }[];
}): { runs: number; failRate: string; microCredits: string } {
  const runs = u.totals?.runs ?? 0;
  const failed = u.totals?.failed ?? 0;
  let micro = 0n;
  for (const r of u.runs ?? []) {
    const t = r.estimatedCredits?.totalMicroCredits;
    if (t && /^\d+$/.test(t)) micro += BigInt(t);
  }
  return {
    runs,
    failRate: runs ? `${((failed / runs) * 100).toFixed(1)}%` : "—",
    microCredits: micro.toString(),
  };
}
