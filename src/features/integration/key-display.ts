// API Key 页的展示判断:纯函数,便于测试(页面与构建页「接入」共用)。

export type KeyExpiry =
  | { kind: "never"; text: string }
  | { kind: "expired"; text: string }
  | { kind: "soon"; text: string }
  | { kind: "date"; text: string };

function ymd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 有效期标签:不过期 / 已过期 / 48 小时内还剩几小时 / 到期日期 */
export function keyExpiry(expiresAt: number | undefined, now: number): KeyExpiry {
  if (!expiresAt) return { kind: "never", text: "不过期" };
  const left = expiresAt - now;
  if (left <= 0) return { kind: "expired", text: "已过期" };
  const hours = Math.ceil(left / 3_600_000);
  if (hours <= 48) return { kind: "soon", text: `${hours} 小时后过期` };
  return { kind: "date", text: `${ymd(expiresAt)} 到期` };
}

/** 本月已用占月度上限(微积分字符串);没有上限返回 null。用到八成算偏高 */
export function monthlyShare(
  usedMicro: string,
  limitMicro: string | undefined,
): { pct: number; high: boolean } | null {
  if (limitMicro === undefined) return null;
  const used = BigInt(usedMicro || "0");
  const limit = BigInt(limitMicro);
  const pct = limit <= 0n ? 100 : Number(used >= limit ? 100n : (used * 100n) / limit);
  return { pct, high: pct >= 80 };
}

/** 每分钟上限的输入:正整数;平台有默认上限时(> 0)不能超过它 */
export function parseRpmDraft(
  raw: string,
  platformMax: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  const range = platformMax > 0 ? `1 到 ${platformMax} 之间的整数` : "正整数";
  if (!/^\d+$/.test(text)) return { ok: false, error: `填 ${range}` };
  const value = Number(text);
  if (value < 1 || (platformMax > 0 && value > platformMax)) {
    return { ok: false, error: `填 ${range}` };
  }
  return { ok: true, value };
}

/** 智能体对调用方的状态:调用默认用发布版,从未发布则用草稿 */
export function accessStatusText(agent: {
  published?: { version: number } | null;
  hasUnpublishedChanges?: boolean;
}): string {
  if (!agent.published) return "未发布，调用使用草稿";
  const base = `已发布 v${agent.published.version}`;
  return agent.hasUnpublishedChanges ? `${base}，草稿有未发布修改（不影响调用方）` : base;
}
