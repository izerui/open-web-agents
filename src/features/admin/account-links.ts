// 账号详情抽屉「相关记录」的跳转地址,以及目标页从地址读筛选的约定。
// 积分账户用 ?account=(计费页本来就认),平台运行用 ?account=,平台审计按操作者用 ?actor=。
// 不带账号时计费页会默认选列表第一个账号,管理员可能对着错误的账号发积分 —— 所以三个链接都必须带上。

export type FilterKey = "account" | "actor";

function href(path: string, tab: string, key: FilterKey, accountId: string): string {
  const q = new URLSearchParams({ tab });
  q.set(key, accountId);
  return `${path}?${q}`;
}

export function accountRecordLinks(accountId: string): {
  billing: string;
  runs: string;
  audit: string;
} {
  return {
    billing: href("/admin/billing", "accounts", "account", accountId),
    runs: href("/admin/ops", "runs", "account", accountId),
    audit: href("/admin/ops", "audit", "actor", accountId),
  };
}

/** 从地址读账号/操作者筛选;没有或为空 = 全部 */
export function filterParam(
  search: Pick<URLSearchParams, "get"> | null | undefined,
  key: FilterKey,
): string {
  return search?.get(key)?.trim() ?? "";
}
