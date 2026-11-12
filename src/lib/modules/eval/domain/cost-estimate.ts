// 评测花费预估(gaps A9):跑一轮评测之前告诉作者大概会花多少积分。纯逻辑。
//
// 口径:按草稿配置的主模型(可能是别名),取近 30 天同一主模型引用、已结算运行的实扣
// (run_charges.charged_micro)最近 20 条求平均,乘以用例数。样本优先取本智能体的,
// 不足再用同模型的其它运行(取样见 adapters/mysql-eval-cost-samples.ts)。
// 一条样本都没有时不给数字(null),前端只说明会计费。
// 金额全程用 BigInt 整数微积分计算,不走浮点累加。

/** 最多取多少条样本求平均 */
export const EVAL_ESTIMATE_SAMPLES = 20;
/** 只看近多少天的运行 */
export const EVAL_ESTIMATE_WINDOW_DAYS = 30;

export interface EvalCostEstimate {
  cases: number;
  model: string;
  /** 实际参与平均的样本数 */
  samples: number;
  /** 单个用例的平均实扣(微积分,十进制整数串);无样本为 null */
  avgMicroCredits: string | null;
  /** avgMicroCredits × cases;无样本为 null */
  totalMicroCredits: string | null;
}

const INTEGER = /^\d+$/;

export function estimateEvalCost(input: {
  cases: number;
  model: string;
  /** 样本实扣(微积分,十进制整数串),按优先级排好序 */
  samples: readonly string[];
}): EvalCostEstimate {
  const valid = input.samples.filter((s) => INTEGER.test(s)).slice(0, EVAL_ESTIMATE_SAMPLES);
  const base = { cases: input.cases, model: input.model, samples: valid.length };
  if (valid.length === 0) return { ...base, avgMicroCredits: null, totalMicroCredits: null };
  const sum = valid.reduce((acc, s) => acc + BigInt(s), 0n);
  const n = BigInt(valid.length);
  // 四舍五入到整数微积分
  const avg = (sum * 2n + n) / (2n * n);
  return {
    ...base,
    avgMicroCredits: avg.toString(),
    totalMicroCredits: (avg * BigInt(Math.max(0, Math.trunc(input.cases)))).toString(),
  };
}
