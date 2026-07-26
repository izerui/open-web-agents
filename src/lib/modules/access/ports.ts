import type { Grant, Permission, ResourceType } from "@/lib/modules/access/domain/grants";

export interface NewGrant {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: Permission;
}

export interface GrantRepo {
  /** 某资源上的全部授权。 */
  listForResource(resourceType: ResourceType, resourceId: string): Promise<Grant[]>;
  /** 某类资源的全部授权 —— 列表页一次拉齐,避免 N+1 查询。 */
  listForType(resourceType: ResourceType): Promise<Grant[]>;
  /** 授权(同一 主体+资源 重复授予时按覆盖处理)。 */
  grant(g: NewGrant): Promise<Grant>;
  revoke(id: string): Promise<void>;
  /** 资源被删除时清掉其授权,避免悬挂记录。 */
  revokeAllForResource(resourceType: ResourceType, resourceId: string): Promise<void>;
}
