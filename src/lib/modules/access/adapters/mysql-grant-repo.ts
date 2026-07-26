import type { Db } from "@/lib/db/client";
import { accessGrants } from "@/lib/db/schema";
import type { Grant, Permission, ResourceType } from "@/lib/modules/access/domain/grants";
import type { GrantRepo, NewGrant } from "@/lib/modules/access/ports";
import { and, eq } from "drizzle-orm";

interface Row {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: string;
  principalId: string;
  permission: string;
}

const COLUMNS = {
  id: accessGrants.id,
  resourceType: accessGrants.resourceType,
  resourceId: accessGrants.resourceId,
  principalType: accessGrants.principalType,
  principalId: accessGrants.principalId,
  permission: accessGrants.permission,
};

function toGrant(r: Row): Grant {
  return {
    id: r.id,
    resourceType: r.resourceType as ResourceType,
    resourceId: r.resourceId,
    principalType: r.principalType as Grant["principalType"],
    principalId: r.principalId,
    permission: r.permission as Permission,
  };
}

export class MysqlGrantRepo implements GrantRepo {
  constructor(private readonly db: Db) {}

  async listForResource(resourceType: ResourceType, resourceId: string): Promise<Grant[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(accessGrants)
      .where(
        and(eq(accessGrants.resourceType, resourceType), eq(accessGrants.resourceId, resourceId)),
      );
    return rows.map(toGrant);
  }

  async listForType(resourceType: ResourceType): Promise<Grant[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(accessGrants)
      .where(eq(accessGrants.resourceType, resourceType))
      .limit(5000);
    return rows.map(toGrant);
  }

  /**
   * 授权。同一 主体+资源 再次授予视为改权限(而非堆叠两条),
   * 否则界面上会出现同一个人两条不同权限的记录、判定结果取决于顺序。
   */
  async grant(g: NewGrant): Promise<Grant> {
    const existing = (await this.listForResource(g.resourceType, g.resourceId)).find(
      (x) => x.principalType === g.principalType && x.principalId === g.principalId,
    );

    if (existing) {
      await this.db
        .update(accessGrants)
        .set({ permission: g.permission })
        .where(eq(accessGrants.id, existing.id));
      return { ...existing, permission: g.permission };
    }

    await this.db.insert(accessGrants).values(g);
    return { ...g };
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(accessGrants).where(eq(accessGrants.id, id));
  }

  async revokeAllForResource(resourceType: ResourceType, resourceId: string): Promise<void> {
    await this.db
      .delete(accessGrants)
      .where(
        and(eq(accessGrants.resourceType, resourceType), eq(accessGrants.resourceId, resourceId)),
      );
  }
}
