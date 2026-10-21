// 评测与发布的关联规则。纯逻辑。
//
// 【按内容关联,不按版本号】评测开跑时记下被测配置的内容摘要(与发布版本同一算法)。某一版(或草稿)
// 的评测结果 = 摘要与它相同的最近一次评测 —— 发布前对草稿跑的评测,发布后就是新版本的结果;
// 草稿改过就对不上,改回原样又对得上。
// 【用例也要对得上】评测开跑时另记这组用例(输入与断言)的摘要;之后增删改用例,旧结果不再算数。
// 【发布门槛】草稿必须有一次"配置相同、用例相同、全部通过"的评测才能发布,没有例外;回滚不受限。

import { createHash } from "node:crypto";
import { stableStringify } from "@/lib/modules/agent/domain/release";
import type { EvalCase, EvalRun } from "../ports";

/**
 * 一组用例的摘要:只看会影响判分的输入与断言,不看名称;与顺序无关。没有用例 = null
 */
export function casesHash(cases: Pick<EvalCase, "id" | "input" | "assertions">[]): string | null {
  if (cases.length === 0) return null;
  const items = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({ id: c.id, input: c.input, assertions: c.assertions }));
  return createHash("sha256").update(stableStringify(items)).digest("hex");
}

export type EvalVerdict =
  /** 一个用例都没有 */
  | { state: "no_cases" }
  /** 这份内容没评测过 */
  | { state: "none" }
  | { state: "running"; run: EvalRun }
  /** 评测之后用例有增删改(或评测早于用例核对,无法确认) */
  | { state: "cases_changed"; run: EvalRun }
  | { state: "failed"; run: EvalRun }
  | { state: "passed"; run: EvalRun };

/**
 * latest:摘要与这份内容相同的最近一次评测;current:当前用例的摘要(null = 没有用例)
 */
export function verdictOf(latest: EvalRun | undefined, current: string | null): EvalVerdict {
  if (current === null) return { state: "no_cases" };
  if (!latest) return { state: "none" };
  if (latest.status !== "done") return { state: "running", run: latest };
  if (latest.casesHash !== current) return { state: "cases_changed", run: latest };
  if (latest.total > 0 && latest.passed === latest.total) return { state: "passed", run: latest };
  return { state: "failed", run: latest };
}

/** 不能发布的原因;能发布返回 null */
export function publishBlockReason(v: EvalVerdict): string | null {
  switch (v.state) {
    case "passed":
      return null;
    case "no_cases":
      return "还没有评测用例:至少添加 1 个用例,对草稿评测全部通过后才能发布";
    case "none":
      return "当前草稿还没有评测过:对草稿运行评测,全部通过后才能发布";
    case "running":
      return "当前草稿的评测还在进行中:等它结束并全部通过后再发布";
    case "cases_changed":
      return "上次评测之后评测用例有改动:需要重新评测并全部通过才能发布";
    case "failed":
      return `当前草稿的评测 ${v.run.passed}/${v.run.total} 通过:全部通过才能发布`;
  }
}
