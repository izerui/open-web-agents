// 用量聚合的纯逻辑:把原始运行记录汇总成看板需要的形状。
// 与 SQL 解耦 —— 聚合规则能被穷举单测,不必起数据库。

export interface RunUsageRecord {
  runId: string;
  assistantId: string;
  assistantName?: string;
  ownerId?: string;
  status: string;
  /** 以整数"微美元"(1e-6 USD)记账。浮点累加会累积误差,金额一律不用 float。 */
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** 运行结束时间(ms);未结束用创建时间。 */
  at: number;
}

export interface UsageTotals {
  runs: number;
  succeeded: number;
  failed: number;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageBucket extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageSummary {
  totals: UsageTotals;
  byAssistant: UsageBucket[];
  byDay: UsageBucket[];
}

const empty = (): UsageTotals => ({
  runs: 0,
  succeeded: 0,
  failed: 0,
  costMicroUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

function accumulate(into: UsageTotals, r: RunUsageRecord): void {
  into.runs++;
  if (r.status === "success") into.succeeded++;
  else if (r.status === "failed") into.failed++;
  into.costMicroUsd += r.costMicroUsd;
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
}

/** UTC 日期键。跨时区部署时口径一致,不随服务器本地时区漂移。 */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function aggregateUsage(records: RunUsageRecord[]): UsageSummary {
  const totals = empty();
  const assistants = new Map<string, UsageBucket>();
  const days = new Map<string, UsageBucket>();

  for (const r of records) {
    accumulate(totals, r);

    const aKey = r.assistantId;
    const a =
      assistants.get(aKey) ??
      ({ key: aKey, label: r.assistantName ?? aKey, ...empty() } as UsageBucket);
    accumulate(a, r);
    assistants.set(aKey, a);

    const dKey = dayKey(r.at);
    const d = days.get(dKey) ?? ({ key: dKey, label: dKey, ...empty() } as UsageBucket);
    accumulate(d, r);
    days.set(dKey, d);
  }

  return {
    totals,
    // 花费高的排前面 —— 看板第一眼要看到钱花在哪
    byAssistant: [...assistants.values()].sort((x, y) => y.costMicroUsd - x.costMicroUsd),
    // 时间序按自然顺序
    byDay: [...days.values()].sort((x, y) => x.key.localeCompare(y.key)),
  };
}

/**
 * 微美元 → 展示用字符串。整数运算,不引入浮点误差。
 *
 * 【进位必须先做】曾经是"先取整数美元、再对余数四舍五入到分",余数进位到 100 时
 * padStart(2) 不补位,于是 999900 显示成 `$0.100` —— 人眼读作一毛钱,实为一块钱,
 * 差一个数量级。错的不是浮点,是进位:任何小数部分 ≥ $0.995 的金额都会中招,
 * 而看板恰好按花费排序,最烧钱的助手反而显示得最便宜。
 */
export function formatUsd(microUsd: number): string {
  const sign = microUsd < 0 ? "-" : "";
  // 先把整个金额四舍五入到"分"再拆分 —— 这样进位天然向上传递
  const totalCents = Math.round(Math.abs(microUsd) / 10_000);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  return `${sign}$${dollars}.${String(cents).padStart(2, "0")}`;
}

/** USD 浮点 → 微美元整数。入库口径统一在这里,避免各处各算。 */
export function toMicroUsd(usd: number | null | undefined): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return 0;
  return Math.round(usd * 1_000_000);
}
