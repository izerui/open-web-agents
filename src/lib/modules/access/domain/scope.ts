/** 查询范围:只看自己的,还是看全平台。 */
export type Scope = "self" | "all";

/**
 * 解析「查全平台还是只查自己」。
 *
 * 【为什么要抽出来】用量和用户组两个接口各写了一遍同样的判断,
 * 而这个判断是安全语义 —— 一旦某处写反(比如 `wantAll || isAdmin`),
 * 普通用户就能拿到全平台数据。同一条规则散在两处、还没有测试,
 * 是迟早要出事的那种重复。
 *
 * 【为什么越权是静默降级而不是 403】返回"你不是管理员"等于告诉调用方
 * 这里存在一个更大的数据集、以及自己差在哪个条件上。降级成 self
 * 既不泄露信息,也不打断正常使用(前端拿不到 all 就照常显示自己的)。
 */
export function resolveScope(raw: string | null, isAdmin: boolean): Scope {
  return raw === "all" && isAdmin ? "all" : "self";
}

/**
 * 范围 → 仓储层的 ownerId 过滤条件。
 * undefined 表示不加过滤(全平台),这正是各 repo 的既有约定。
 */
export function ownerFilter(scope: Scope, userId: string): string | undefined {
  return scope === "all" ? undefined : userId;
}
