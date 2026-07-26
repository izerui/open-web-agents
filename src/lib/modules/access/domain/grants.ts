// 通用授权:一张 access_grants 表覆盖所有资源类型(open-webui 范式)。
// 纯逻辑、零 IO —— 授权规则必须能被穷举单测。
//
// 与"归属"的分工:
// - 归属(ownerId/callerApiKeyId)决定【会话/运行】这类私有执行痕迹归谁
// - 授权(本文件)决定【助手】这类可共享的定义能被谁使用/修改
// 两者独立:把助手分享给同事,不等于同事能看你用它跑出来的会话。

export type Permission = "read" | "write";
export type ResourceType = "assistant";

/** `*` 作为 principalId 表示"所有登录用户"(公开)。 */
export const PUBLIC_PRINCIPAL = "*";

export interface Grant {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: Permission;
}

export interface Subject {
  userId: string;
  role?: "admin" | "user";
  /** 用户所属群组 id(群组功能未启用时为空)。 */
  groupIds?: string[];
}

/** write 蕴含 read —— 能改的人当然能看。 */
function satisfies(granted: Permission, needed: Permission): boolean {
  return granted === "write" || granted === needed;
}

function matchesSubject(g: Grant, s: Subject): boolean {
  if (g.principalType === "*" || g.principalId === PUBLIC_PRINCIPAL) return true;
  if (g.principalType === "user") return g.principalId === s.userId;
  if (g.principalType === "group") return (s.groupIds ?? []).includes(g.principalId);
  return false;
}

export interface OwnedResource {
  id: string;
  ownerId: string;
}

/**
 * 判定某主体对某资源是否有指定权限。
 *
 * 顺序:owner 恒有全权 → admin 恒有全权 → 逐条匹配授权。
 * admin 在这里放开是刻意的:助手是平台配置资产,管理员需要能接管无人维护的助手。
 * (注意这与会话的规则不同 —— 会话是私有执行痕迹,admin 也不越权,见 principal.ts。)
 */
export function hasResourceAccess(
  s: Subject,
  resource: OwnedResource,
  needed: Permission,
  grants: Grant[],
): boolean {
  if (resource.ownerId === s.userId) return true;
  if (s.role === "admin") return true;

  return grants.some(
    (g) => g.resourceId === resource.id && matchesSubject(g, s) && satisfies(g.permission, needed),
  );
}

/** 过滤出主体可见(有 read 权限)的资源。 */
export function filterVisible<T extends OwnedResource>(
  s: Subject,
  resources: T[],
  grants: Grant[],
): T[] {
  return resources.filter((r) => hasResourceAccess(s, r, "read", grants));
}

/** 资源是否已公开(供界面显示"公开"标记)。 */
export function isPublic(resourceId: string, grants: Grant[]): boolean {
  return grants.some(
    (g) =>
      g.resourceId === resourceId &&
      (g.principalType === "*" || g.principalId === PUBLIC_PRINCIPAL),
  );
}
