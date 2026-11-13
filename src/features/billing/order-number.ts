// 订单短号:用户侧「我的订单」与管理端订单页签用同一种写法(前 8 位大写),
// 用户联系管理员时报的号对得上;悬停/复制拿完整编号。

export function shortOrderId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/** 管理端订单搜索:短号(大小写都认、可带 #)、完整编号、邮箱(没有邮箱时账号 ID)、套餐名 */
export function orderMatches(
  order: { id: string; accountEmail?: string | null; accountId: string; packageName: string },
  query: string,
): boolean {
  const q = query.trim().replace(/^#/, "").trim().toLowerCase();
  if (!q) return true;
  return [order.id, order.accountEmail ?? order.accountId, order.packageName].some((field) =>
    field.toLowerCase().includes(q),
  );
}
